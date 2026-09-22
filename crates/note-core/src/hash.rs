//! 内容哈希与 ID 生成。
use sha2::{Digest, Sha256};

/// 整篇 / 单块的内容 hash，用于增量判断、乐观并发（expect_hash）与快照去重。
pub fn content_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

pub fn content_hash_str(s: &str) -> String {
    content_hash(s.as_bytes())
}

/// 内容寻址的资产相对路径：`attachments/ab/abcdef...<full>.<ext>`。
pub fn asset_path(hex_digest: &str, ext: &str) -> String {
    let prefix = &hex_digest[..2.min(hex_digest.len())];
    let ext = ext.trim_start_matches('.');
    if ext.is_empty() {
        format!("attachments/{prefix}/{hex_digest}")
    } else {
        format!("attachments/{prefix}/{hex_digest}.{ext}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_hex64() {
        let a = content_hash_str("你好 note");
        assert_eq!(a.len(), 64);
        assert_eq!(a, content_hash_str("你好 note"));
        assert_ne!(a, content_hash_str("你好 note!"));
    }

    #[test]
    fn asset_path_shape() {
        let h = content_hash_str("x");
        let p = asset_path(&h, "png");
        assert!(p.starts_with("attachments/"), "{p}");
        assert!(p.ends_with(".png"), "{p}");
        assert_eq!(p.split('/').count(), 3);
    }
}
