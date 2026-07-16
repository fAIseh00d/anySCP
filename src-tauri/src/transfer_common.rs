//! Shared bits between the SFTP and SCP transfer managers.

use std::path::{Path, PathBuf};

/// Browser-style staging path for an in-flight download: `<name>.part` beside
/// the final destination. The final name only appears once the download
/// completed, so an interrupted transfer can't be mistaken for a complete
/// file — and for SFTP the staged bytes double as the resume offset.
#[must_use]
pub fn part_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_part_to_the_full_file_name() {
        assert_eq!(
            part_path_for(Path::new("/tmp/foo.tar.gz")),
            PathBuf::from("/tmp/foo.tar.gz.part"),
        );
        assert_eq!(part_path_for(Path::new("/a/b")), PathBuf::from("/a/b.part"));
    }
}
