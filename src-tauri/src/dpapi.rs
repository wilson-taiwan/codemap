//! Windows DPAPI protection for the stored refresh token.
//!
//! Why DPAPI: an AppData ACL is not encryption; anyone reading the file from
//! another context is out of luck only as long as ACLs hold. Current-user
//! DPAPI binds ciphertext to this Windows user on this machine with no
//! prompts, no machine-wide scope, and no UI — matching what macOS gets from
//! the 0600 file without pretending either one is a Keychain.
//!
//! Contract (enforced by tests on a real Windows runner):
//!   - no UI callbacks, no optional prompts (`CRYPTPROTECT_UI_FORBIDDEN`);
//!   - never `CRYPTPROTECT_LOCAL_MACHINE`;
//!   - output buffers are copied into owned Vecs and originals freed;
//!   - corrupt/wrong-context blobs yield `None`, never a raw Win32 error.

#![cfg(windows)]

use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

/// Protect arbitrary bytes bound to the current user on this machine.
pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
    if plain.is_empty() {
        return None;
    }
    let in_blob = blob(plain);
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(), // description
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(), // no prompt struct
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() || out_blob.cbData == 0 {
        return None;
    }
    // Copy out of system-allocated memory before freeing.
    let cipher = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let owned = cipher.to_vec();
    unsafe {
        win32_memory_free(out_blob.pbData);
    }
    Some(owned)
}

/// Unprotect a blob produced by `protect` under the same user/machine.
pub fn unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    if cipher.is_empty() {
        return None;
    }
    let in_blob = blob(cipher);
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() || out_blob.cbData == 0 {
        return None;
    }
    let plain = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let owned = plain.to_vec();
    unsafe {
        win32_memory_free(out_blob.pbData);
    }
    // The stored payload must be valid UTF-8 (a refresh token); anything else
    // means corrupt or wrong-context data and yields no token.
    match String::from_utf8(owned) {
        Ok(text) if !text.is_empty() => Some(text.into_bytes()),
        _ => None,
    }
}

/// Free a DPAPI output blob allocated by Win32.
///
/// # Safety
/// `ptr` must be a non-null pointer that Win32 allocated with `LocalAlloc`
/// (here, the `pbData` of a DPAPI output blob) and must not be used again
/// afterwards. Declaring this `unsafe` is what makes the `unsafe` blocks at
/// the call sites correct rather than redundant.
unsafe fn win32_memory_free(ptr: *mut u8) {
    // HLOCAL is a plain pointer in windows-sys; free system-allocated blobs.
    // LocalFree lives in Win32::Foundation, not Win32::System::Memory.
    use windows_sys::Win32::Foundation::LocalFree;
    let _ = LocalFree(ptr as *mut core::ffi::c_void);
}
