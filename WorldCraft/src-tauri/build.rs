// Builds the environment assets into the exe, so WorldCraft has them wherever it runs: from inside a zip, or moved away
// from its folder. Own code with no extra crates: writes a table of include_bytes! for main.rs.
use std::{env, fs, path::{Path, PathBuf}, time::UNIX_EPOCH};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, out); } else { out.push(p); }
    }
}

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../GameCraft/asset-library/world");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    walk(&root, &mut files);
    files.sort();
    assert!(!files.is_empty(), "no assets found in {}", root.display());
    let (mut size, mut newest) = (0u64, 0u64);
    let mut table = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for f in &files {
        let abs = f.canonicalize().unwrap();
        let md = fs::metadata(&abs).unwrap();
        size += md.len();
        newest = newest.max(md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()));
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let path = abs.to_string_lossy().replace("\\\\?\\", "");
        table += &format!("    ({rel:?}, include_bytes!({path:?})),\n");
    }
    table += "];\n";
    table += &format!("pub const STAMP: &str = \"{}-{size}-{newest}\";\n", files.len());
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("embedded_assets.rs"), table).unwrap();
    tauri_build::build()
}
