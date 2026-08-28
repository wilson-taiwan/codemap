fn main() {
    // Build provenance: embed the exact commit so Trust Center / About can
    // show it and release verifiers can check it. An unset value must stay an
    // honest "development", never a fabricated hash.
    println!("cargo:rerun-if-env-changed=FLEURON_BUILD_COMMIT");
    let commit = std::env::var("FLEURON_BUILD_COMMIT").unwrap_or_default();
    println!(
        "cargo:rustc-env=FLEURON_BUILD_COMMIT={}",
        if commit.is_empty() {
            "development"
        } else {
            &commit
        }
    );
    tauri_build::build()
}
