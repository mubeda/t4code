use std::{collections::BTreeSet, fs, time::Duration};

use t4code_desktop_lib::ssh::{
    DiscoveredSshHost, RemoteLaunchResult, SshAuthOptions, SshEnvironmentBootstrap,
    SshEnvironmentLaunchPlan, SshEnvironmentTarget, SshPasswordPromptManager,
    SshPasswordPromptResolution, SshPasswordPromptResolveError, discover_ssh_hosts,
    parse_known_hosts_hostnames, parse_remote_launch_result, parse_remote_pairing_credential,
};

fn target() -> SshEnvironmentTarget {
    SshEnvironmentTarget {
        alias: " devbox ".to_string(),
        hostname: " devbox.internal ".to_string(),
        username: Some(" alice ".to_string()),
        port: Some(2222),
    }
}

#[test]
fn public_launch_plans_normalize_targets_and_preserve_bootstrap_contracts() {
    let external = SshEnvironmentLaunchPlan::external(target(), 45_123)
        .expect("external launch plan should build");
    assert_eq!(external.target.alias, "devbox");
    assert_eq!(external.target.hostname, "devbox.internal");
    assert_eq!(external.target.username.as_deref(), Some("alice"));
    assert_eq!(external.remote_port, 3773);
    assert_eq!(external.remote_server_kind, "external");
    assert_eq!(external.http_base_url, "http://127.0.0.1:45123/");
    assert!(external.args.windows(2).any(|pair| pair == ["-p", "2222"]));
    assert_eq!(
        external.args.last().map(String::as_str),
        Some("alice@devbox")
    );

    let managed = SshEnvironmentLaunchPlan::forward_with_auth(
        SshEnvironmentTarget {
            alias: String::new(),
            hostname: "host.internal".to_string(),
            username: None,
            port: None,
        },
        45_124,
        RemoteLaunchResult {
            remote_port: 41_111,
            server_kind: "managed".to_string(),
        },
        &SshAuthOptions::with_secret("secret".to_string()),
    )
    .expect("managed launch plan should build");
    assert_eq!(managed.target.alias, "host.internal");
    assert_eq!(managed.args[1], "BatchMode=no");
    assert_eq!(managed.remote_server_kind, "managed");

    let batch = SshEnvironmentLaunchPlan::forward(
        managed.target.clone(),
        45_125,
        RemoteLaunchResult {
            remote_port: 41_112,
            server_kind: "unexpected".to_string(),
        },
    )
    .expect("batch launch plan should build");
    assert_eq!(batch.args[1], "BatchMode=yes");
    assert_eq!(batch.remote_server_kind, "managed");

    let bootstrap = SshEnvironmentBootstrap::new(
        managed.target.clone(),
        managed.remote_port,
        managed.http_base_url.clone(),
        managed.ws_base_url.clone(),
        Some("pairing-token".to_string()),
        "managed",
    );
    let external_bootstrap = SshEnvironmentBootstrap::external(
        external.target,
        external.remote_port,
        external.http_base_url,
        external.ws_base_url,
        None,
    );
    assert_eq!(bootstrap.remote_server_kind, "managed");
    assert_eq!(external_bootstrap.remote_server_kind, "external");
    assert_eq!(external_bootstrap.pairing_token, None);

    assert!(
        SshEnvironmentLaunchPlan::external(
            SshEnvironmentTarget {
                alias: " ".to_string(),
                hostname: " ".to_string(),
                username: None,
                port: None,
            },
            45_126,
        )
        .is_err()
    );
}

#[test]
fn public_remote_parsers_cover_success_defaults_and_validation_errors() {
    assert_eq!(
        parse_remote_pairing_credential("shell banner\n{\"credential\":\" pairing-token \"}\n",),
        Ok("pairing-token".to_string())
    );
    for invalid in [
        "",
        "not-json",
        "{\"credential\":42}",
        "{\"credential\":\"\"}",
    ] {
        assert!(parse_remote_pairing_credential(invalid).is_err());
    }

    assert_eq!(
        parse_remote_launch_result("banner\n{\"remotePort\":4111}\n")
            .expect("launch document should parse"),
        RemoteLaunchResult {
            remote_port: 4111,
            server_kind: "managed".to_string(),
        }
    );
    assert_eq!(
        parse_remote_launch_result("{\"remotePort\":3773,\"serverKind\":\"external\"}")
            .expect("external launch document should parse")
            .server_kind,
        "external"
    );
    for invalid in [
        "",
        "not-json",
        "{\"remotePort\":0}",
        "{\"remotePort\":65536}",
        "{\"remotePort\":3773,\"serverKind\":\"bogus\"}",
    ] {
        assert!(parse_remote_launch_result(invalid).is_err());
    }

    assert_eq!(
        parse_known_hosts_hostnames(
            "github.com,git.example ssh-ed25519 AAAA\n\
             |1|hashed|entry ssh-ed25519 BBBB\n\
             @cert-authority *.example.com ssh-ed25519 CCCC\n\
             [bastion.example.com]:2222 ssh-ed25519 DDDD\n\
             ::1 ssh-ed25519 EEEE\n",
        ),
        BTreeSet::from([
            "::1".to_string(),
            "bastion.example.com".to_string(),
            "git.example".to_string(),
            "github.com".to_string(),
        ])
    );
}

#[test]
fn public_discovery_and_prompt_resolution_cover_filesystem_and_error_contracts() {
    let home = tempfile::tempdir().expect("temporary home should create");
    let ssh_dir = home.path().join(".ssh");
    let include_dir = ssh_dir.join("config dir");
    fs::create_dir_all(&include_dir).expect("SSH include directory should create");
    fs::write(
        ssh_dir.join("config"),
        "Host devbox wildcard*\n  HostName ignored.example\n\
         Include \"config dir/team.conf\"\n",
    )
    .expect("SSH config should write");
    fs::write(include_dir.join("team.conf"), "Host staging\n")
        .expect("included SSH config should write");
    fs::write(
        ssh_dir.join("known_hosts"),
        "known.example ssh-ed25519 AAAA\n[devbox]:2222 ssh-ed25519 BBBB\n",
    )
    .expect("known hosts should write");

    let hosts =
        discover_ssh_hosts(Some(home.path().to_path_buf())).expect("SSH hosts should discover");
    assert_eq!(
        hosts,
        vec![
            DiscoveredSshHost {
                alias: "devbox".to_string(),
                hostname: "devbox".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            },
            DiscoveredSshHost {
                alias: "known.example".to_string(),
                hostname: "known.example".to_string(),
                username: None,
                port: None,
                source: "known-hosts",
            },
            DiscoveredSshHost {
                alias: "staging".to_string(),
                hostname: "staging".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            },
        ]
    );
    assert!(hosts[0].to_value().is_object());
    assert!(
        discover_ssh_hosts(None)
            .expect("missing home should be empty")
            .is_empty()
    );

    let manager = SshPasswordPromptManager::with_timeout(Duration::from_millis(1));
    assert_eq!(
        manager.resolve(SshPasswordPromptResolution {
            request_id: " ".to_string(),
            password: None,
        }),
        Err(SshPasswordPromptResolveError::InvalidRequestId)
    );
    assert_eq!(
        manager.resolve(SshPasswordPromptResolution {
            request_id: "expired".to_string(),
            password: Some("secret".to_string()),
        }),
        Err(SshPasswordPromptResolveError::Expired {
            request_id: "expired".to_string(),
        })
    );
    let default_manager = SshPasswordPromptManager::new();
    assert_eq!(
        default_manager.resolve(SshPasswordPromptResolution {
            request_id: "missing".to_string(),
            password: None,
        }),
        Err(SshPasswordPromptResolveError::Expired {
            request_id: "missing".to_string(),
        })
    );
}
