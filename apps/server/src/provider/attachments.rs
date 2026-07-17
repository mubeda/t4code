use std::path::{Component, Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;
use url::Url;

#[derive(Clone, Debug)]
pub(crate) struct AttachmentMaterializer {
    attachments_dir: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MaterializedImage {
    pub name: String,
    pub mime_type: String,
    pub base64_data: String,
    pub file_url: String,
}

#[derive(Debug, Error)]
pub(crate) enum AttachmentMaterializationError {
    #[error("invalid attachment metadata: {0}")]
    InvalidMetadata(String),
    #[error("invalid attachment id {0}")]
    InvalidId(String),
    #[error("failed to access attachment directory {path}: {source}")]
    AttachmentDirectory {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read attachment {id}: {source}")]
    Read { id: String, source: std::io::Error },
    #[error("attachment {0} resolves outside the attachment directory")]
    EscapesDirectory(String),
    #[error("attachment {0} cannot be represented as a file URL")]
    InvalidFileUrl(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageAttachment {
    #[serde(rename = "type")]
    attachment_type: String,
    id: String,
    name: String,
    mime_type: String,
}

impl AttachmentMaterializer {
    pub(crate) fn new(attachments_dir: PathBuf) -> Self {
        Self { attachments_dir }
    }

    pub(crate) async fn materialize(
        &self,
        attachments: Vec<Value>,
    ) -> Result<Vec<MaterializedImage>, AttachmentMaterializationError> {
        if attachments.is_empty() {
            return Ok(Vec::new());
        }
        let root = tokio::fs::canonicalize(&self.attachments_dir)
            .await
            .map_err(
                |source| AttachmentMaterializationError::AttachmentDirectory {
                    path: self.attachments_dir.clone(),
                    source,
                },
            )?;
        let mut images = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            let attachment: ImageAttachment =
                serde_json::from_value(attachment).map_err(|error| {
                    AttachmentMaterializationError::InvalidMetadata(error.to_string())
                })?;
            if attachment.attachment_type != "image" || !attachment.mime_type.starts_with("image/")
            {
                return Err(AttachmentMaterializationError::InvalidMetadata(
                    "only image attachments are supported".to_owned(),
                ));
            }
            validate_attachment_id(&attachment.id)?;
            let path = tokio::fs::canonicalize(root.join(&attachment.id))
                .await
                .map_err(|source| AttachmentMaterializationError::Read {
                    id: attachment.id.clone(),
                    source,
                })?;
            if !path.starts_with(&root) {
                return Err(AttachmentMaterializationError::EscapesDirectory(
                    attachment.id,
                ));
            }
            let bytes = tokio::fs::read(&path).await.map_err(|source| {
                AttachmentMaterializationError::Read {
                    id: attachment.id.clone(),
                    source,
                }
            })?;
            let file_url = Url::from_file_path(&path)
                .map_err(|()| AttachmentMaterializationError::InvalidFileUrl(attachment.id))?
                .to_string();
            images.push(MaterializedImage {
                name: attachment.name,
                mime_type: attachment.mime_type,
                base64_data: STANDARD.encode(bytes),
                file_url,
            });
        }
        Ok(images)
    }
}

pub(crate) fn prompt_parts(text: Option<&str>, attachments: Vec<Value>) -> Vec<Value> {
    let mut parts = Vec::with_capacity(attachments.len() + usize::from(text.is_some()));
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        parts.push(serde_json::json!({ "type": "text", "text": text }));
    }
    parts.extend(attachments);
    parts
}

fn validate_attachment_id(id: &str) -> Result<(), AttachmentMaterializationError> {
    let mut components = Path::new(id).components();
    let valid_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let valid_characters = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if valid_component && valid_characters {
        Ok(())
    } else {
        Err(AttachmentMaterializationError::InvalidId(id.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::AttachmentMaterializer;

    #[tokio::test]
    async fn materializes_an_image_attachment_from_the_state_directory() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments dir");
        tokio::fs::write(attachments_dir.join("image-1"), b"image bytes")
            .await
            .expect("attachment file");

        let images = AttachmentMaterializer::new(attachments_dir)
            .materialize(vec![json!({
                "type": "image",
                "id": "image-1",
                "name": "screen.png",
                "mimeType": "image/png",
                "sizeBytes": 11
            })])
            .await
            .expect("materialized image");

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].name, "screen.png");
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].base64_data, "aW1hZ2UgYnl0ZXM=");
        assert!(images[0].file_url.starts_with("file://"));
    }

    #[tokio::test]
    async fn rejects_attachment_ids_that_escape_the_state_directory() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments dir");
        tokio::fs::write(state.path().join("outside"), b"secret")
            .await
            .expect("outside file");

        let error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "image",
                "id": "../outside",
                "name": "outside.png",
                "mimeType": "image/png",
                "sizeBytes": 6
            })])
            .await
            .expect_err("traversal must fail");

        assert!(error.to_string().contains("invalid attachment id"));

        let missing_root_error = AttachmentMaterializer::new(state.path().join("missing"))
            .materialize(vec![json!({
                "type": "image",
                "id": "image-1",
                "name": "missing.png",
                "mimeType": "image/png"
            })])
            .await
            .expect_err("a missing attachment directory must fail");
        assert!(
            missing_root_error
                .to_string()
                .contains("failed to access attachment directory")
        );

        let invalid_metadata_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({ "type": "image" })])
            .await
            .expect_err("incomplete metadata must fail");
        assert!(
            invalid_metadata_error
                .to_string()
                .contains("invalid attachment metadata")
        );

        let unsupported_attachment_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "file",
                "id": "image-1",
                "name": "notes.txt",
                "mimeType": "text/plain"
            })])
            .await
            .expect_err("non-image attachments must fail");
        assert!(
            unsupported_attachment_error
                .to_string()
                .contains("only image attachments are supported")
        );

        let missing_attachment_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "image",
                "id": "missing",
                "name": "missing.png",
                "mimeType": "image/png"
            })])
            .await
            .expect_err("a missing attachment must fail");
        assert!(
            missing_attachment_error
                .to_string()
                .contains("failed to read attachment")
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                state.path().join("outside"),
                attachments_dir.join("linked-image"),
            )
            .expect("attachment symlink");
            let symlink_error = AttachmentMaterializer::new(attachments_dir)
                .materialize(vec![json!({
                    "type": "image",
                    "id": "linked-image",
                    "name": "outside.png",
                    "mimeType": "image/png"
                })])
                .await
                .expect_err("a symlink outside the attachment directory must fail");
            assert!(symlink_error.to_string().contains("resolves outside"));
        }
    }

    #[test]
    fn prompt_parts_preserve_text_and_attachment_only_turns() {
        let image = json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" });

        assert_eq!(
            super::prompt_parts(Some("describe this"), vec![image.clone()]),
            vec![
                json!({ "type": "text", "text": "describe this" }),
                image.clone()
            ]
        );
        assert_eq!(
            super::prompt_parts(Some(""), vec![image.clone()]),
            vec![image]
        );
    }
}
