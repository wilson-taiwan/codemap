fn main() {
    // Build provenance: embed the exact commit so Trust Center / About can
    // show it and release verifiers can check it. An unset value must stay an
    // honest "development", never a fabricated hash.
    println!("cargo:rerun-if-env-changed=CODEMAP_BUILD_COMMIT");
    let commit = std::env::var("CODEMAP_BUILD_COMMIT").unwrap_or_default();
    println!(
        "cargo:rustc-env=CODEMAP_BUILD_COMMIT={}",
        if commit.is_empty() {
            "development"
        } else {
            &commit
        }
    );
    // Windows test binaries get no application manifest -- tauri-build embeds
    // one only for the app. Without it the process loads comctl32 v5 from
    // System32, which does not export TaskDialogIndirect (imported via rfd's
    // Windows dialogs), so the test executable dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before a single test runs.
    // Declaring the Common-Controls v6 dependency for test targets loads the
    // v6 comctl32 that actually exports it.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' \
name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
