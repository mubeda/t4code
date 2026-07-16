use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::{
    model::{AuthAccessChange, AuthAccessEvent},
    service::AuthService,
};
use crate::rpc::{RpcRegistry, RpcSessionContext, RpcStreamChunk};

const AUTH_STREAM_CAPACITY: usize = 8;

pub(crate) fn register_rpc_handlers(registry: &mut RpcRegistry, auth: AuthService) {
    registry.register_stream_with_context(
        "subscribeAuthAccess",
        move |_request, context, cancellation| {
            auth_access_stream(auth.clone(), context, cancellation)
        },
    );
}

fn auth_access_stream(
    auth: AuthService,
    context: RpcSessionContext,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(AUTH_STREAM_CAPACITY);
    tokio::spawn(async move {
        let current_session_id = context.current_session_id().unwrap_or_default().to_owned();
        let mut events = auth.subscribe_access();
        let (mut revision, pairings, clients) = auth.access_snapshot(&current_session_id).await;
        if !send_value(
            &sender,
            &cancellation,
            snapshot_value(revision, pairings, clients),
        )
        .await
        {
            return;
        }

        loop {
            let event = tokio::select! {
                () = cancellation.cancelled() => break,
                event = events.recv() => event,
            };
            match event {
                Ok(event) if event.revision > revision => {
                    revision = event.revision;
                    if !send_value(
                        &sender,
                        &cancellation,
                        access_event_value(event, &current_session_id),
                    )
                    .await
                    {
                        break;
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let (snapshot_revision, pairings, clients) =
                        auth.access_snapshot(&current_session_id).await;
                    revision = snapshot_revision;
                    if !send_value(
                        &sender,
                        &cancellation,
                        snapshot_value(revision, pairings, clients),
                    )
                    .await
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    receiver
}

async fn send_value(
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
    value: Value,
) -> bool {
    tokio::select! {
        () = cancellation.cancelled() => false,
        result = sender.send(Ok(vec![value])) => result.is_ok(),
    }
}

fn snapshot_value(
    revision: u64,
    pairing_links: Vec<super::model::PairingLinkView>,
    client_sessions: Vec<super::model::ClientSessionView>,
) -> Value {
    json!({
        "version": 1,
        "revision": revision,
        "type": "snapshot",
        "payload": {
            "pairingLinks": pairing_links,
            "clientSessions": client_sessions,
        },
    })
}

fn access_event_value(event: AuthAccessEvent, current_session_id: &str) -> Value {
    let revision = event.revision;
    match event.change {
        AuthAccessChange::PairingLinkUpserted(pairing) => json!({
            "version": 1,
            "revision": revision,
            "type": "pairingLinkUpserted",
            "payload": pairing,
        }),
        AuthAccessChange::PairingLinkRemoved { id } => json!({
            "version": 1,
            "revision": revision,
            "type": "pairingLinkRemoved",
            "payload": { "id": id },
        }),
        AuthAccessChange::ClientUpserted(mut client) => {
            client.current = client.session_id == current_session_id;
            json!({
                "version": 1,
                "revision": revision,
                "type": "clientUpserted",
                "payload": client,
            })
        }
        AuthAccessChange::ClientRemoved { session_id } => json!({
            "version": 1,
            "revision": revision,
            "type": "clientRemoved",
            "payload": { "sessionId": session_id },
        }),
    }
}
