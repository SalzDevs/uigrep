//! Fail-closed master credential storage. Never rotate an unreadable/invalid
//! credential or use an in-memory credential whose persistence failed.
//! Atomic hard-link publication prevents clobbering a concurrent creator and
//! prevents readers seeing a partially written token. Unsupported filesystems
//! fail closed. std path APIs cannot prevent hostile ancestor replacement;
//! Windows access control relies on the user's inherited profile ACL.
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;

const MAX_TOKEN_FILE_BYTES: usize = 128;
const INVALID: &str = "The master token file is invalid. No credential was replaced.";

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn prepare_directory(dir: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|_| "Cannot create the private configuration directory.")?;
    let metadata = fs::symlink_metadata(dir)
        .map_err(|_| "Cannot inspect the private configuration directory.")?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err("The private configuration directory must not be a link or reparse point.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot restrict configuration directory permissions.")?;
    }
    Ok(())
}

fn validate(value: &str) -> Result<String, String> {
    let token = value.trim();
    let hex = token.len() == 64
        && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    // Preserve canonical v4 UUID credentials written by older desktop builds.
    let legacy = token.len() == 36 && Uuid::parse_str(token).is_ok_and(|id| {
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == token
    });
    if hex || legacy {
        Ok(token.to_owned())
    } else {
        Err(INVALID.into())
    }
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect the master token file.".into()),
    };
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > MAX_TOKEN_FILE_BYTES as u64 {
        return Err(INVALID.into());
    }
    let file = File::open(path).map_err(|_| "Cannot read the master token file.")?;
    let opened = file.metadata().map_err(|_| "Cannot inspect the open master token file.")?;
    if !opened.is_file() || opened.len() > MAX_TOKEN_FILE_BYTES as u64 {
        return Err(INVALID.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err("The master token file changed while opening.".into());
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot restrict master token permissions.")?;
    }
    let mut value = String::new();
    file.take((MAX_TOKEN_FILE_BYTES + 1) as u64)
        .read_to_string(&mut value)
        .map_err(|_| "Cannot read the master token file as UTF-8.")?;
    if value.len() > MAX_TOKEN_FILE_BYTES {
        return Err(INVALID.into());
    }
    validate(&value).map(Some)
}

fn publish(dir: &Path, path: &Path, token: &str) -> Result<(), String> {
    let stage = dir.join(format!(".token-{}.stage", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&stage).map_err(|_| "Cannot create a private master token file.")?;
    let result = (|| {
        file.write_all(token.as_bytes()).and_then(|_| file.sync_all())
            .map_err(|_| "Cannot durably write the master token file.")?;
        // Unlike rename, this never replaces an existing credential.
        match fs::hard_link(&stage, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err("Cannot publish the master token file without replacing existing data."),
        }
    })();
    drop(file);
    let cleanup = fs::remove_file(&stage);
    result?;
    cleanup.map_err(|_| "Cannot remove the private master token staging file.")?;
    #[cfg(unix)]
    File::open(dir).and_then(|file| file.sync_all())
        .map_err(|_| "Cannot durably save the master token directory.")?;
    Ok(())
}

pub(crate) fn load_or_create(dir: &Path) -> Result<String, String> {
    prepare_directory(dir)?;
    let path = dir.join("token");
    if let Some(token) = read_existing(&path)? {
        return Ok(token);
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    publish(dir, &path, &token)?;
    // Re-read the durable winner, including when another process created it.
    read_existing(&path)?.ok_or_else(|| "The master token disappeared after creation.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox(std::path::PathBuf);
    impl Sandbox {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("uigrep-token-{}", Uuid::new_v4())))
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn creates_and_reuses_a_persisted_token() {
        let s = Sandbox::new();
        let first = load_or_create(&s.0).unwrap();
        assert!(first.len() == 64);
        assert!(load_or_create(&s.0).unwrap() == first);
        assert!(fs::read_to_string(s.0.join("token")).unwrap() == first);
        assert_eq!(fs::read_dir(&s.0).unwrap().count(), 1);
    }

    #[test]
    fn accepts_legacy_uuid_and_rejects_invalid_credentials_without_disclosure() {
        assert!(validate(&format!("{}\r\n", Uuid::new_v4())).is_ok());
        for input in ["".into(), " \n".into(), "secret".into(), "a".repeat(63),
            "A".repeat(64), "g".repeat(64), Uuid::nil().to_string(), "a".repeat(129)] {
            assert!(validate(&input).err().as_deref() == Some(INVALID));
        }
    }

    #[test]
    fn invalid_files_are_never_rotated() {
        for bytes in [b"".to_vec(), b"private-invalid-value".to_vec(), vec![0xff], vec![b'a'; 129]] {
            let s = Sandbox::new();
            fs::create_dir(&s.0).unwrap();
            fs::write(s.0.join("token"), &bytes).unwrap();
            assert!(load_or_create(&s.0).is_err());
            assert!(fs::read(s.0.join("token")).unwrap() == bytes);
        }
    }

    #[test]
    fn publication_never_overwrites_a_winner() {
        let s = Sandbox::new();
        let winner = load_or_create(&s.0).unwrap();
        publish(&s.0, &s.0.join("token"), &"b".repeat(64)).unwrap();
        assert!(load_or_create(&s.0).unwrap() == winner);
    }

    #[test]
    fn filesystem_failures_return_errors_not_ephemeral_credentials() {
        let s = Sandbox::new();
        fs::create_dir(&s.0).unwrap();
        fs::create_dir(s.0.join("token")).unwrap();
        assert!(load_or_create(&s.0).is_err());
        assert!(publish(&s.0.join("missing"), &s.0.join("other"), &"a".repeat(64)).is_err());
        let file = s.0.join("not-a-directory");
        fs::write(&file, b"x").unwrap();
        assert!(load_or_create(&file).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unix_permissions_are_restricted_and_links_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let s = Sandbox::new();
        load_or_create(&s.0).unwrap();
        let path = s.0.join("token");
        fs::set_permissions(&s.0, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        load_or_create(&s.0).unwrap();
        assert_eq!(fs::metadata(&s.0).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_file(&path).unwrap();
        symlink(s.0.join("missing"), &path).unwrap();
        assert!(load_or_create(&s.0).is_err());
        assert!(!s.0.join("missing").exists());
        let alias = s.0.join("alias");
        symlink(&s.0, &alias).unwrap();
        assert!(load_or_create(&alias).is_err());
    }
}