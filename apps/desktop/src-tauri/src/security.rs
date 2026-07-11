use base64::{Engine as _, engine::general_purpose::STANDARD};

pub const CONNECTION_CATALOG_PROTECTION_KIND: &str = "windows-dpapi";

pub fn protect_string(value: &str) -> Result<String, String> {
    protect_bytes(value.as_bytes()).map(|bytes| STANDARD.encode(bytes))
}

pub fn unprotect_string(value: &str) -> Result<String, String> {
    let encrypted = STANDARD
        .decode(value)
        .map_err(|error| format!("Could not decode protected catalog payload: {error}"))?;
    let clear = unprotect_bytes(&encrypted)?;
    String::from_utf8(clear)
        .map_err(|error| format!("Protected catalog payload was not valid UTF-8: {error}"))
}

#[cfg(target_os = "windows")]
fn protect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    platform_windows::protect_bytes(bytes)
}

#[cfg(target_os = "windows")]
fn unprotect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    platform_windows::unprotect_bytes(bytes)
}

#[cfg(not(target_os = "windows"))]
fn protect_bytes(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("OS-backed catalog protection is not implemented on this platform.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_bytes(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("OS-backed catalog protection is not implemented on this platform.".to_string())
}

#[cfg(target_os = "windows")]
mod platform_windows {
    use std::{io, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };

    fn input_blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, String> {
        let cb_data = u32::try_from(bytes.len())
            .map_err(|_| "Protected catalog payload is too large.".to_string())?;
        Ok(CRYPT_INTEGER_BLOB {
            cbData: cb_data,
            pbData: bytes.as_ptr() as *mut u8,
        })
    }

    fn take_output_blob(blob: &mut CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if blob.pbData.is_null() || blob.cbData == 0 {
            return Vec::new();
        }

        let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) };
        let value = bytes.to_vec();
        unsafe {
            LocalFree(blob.pbData.cast());
        }
        blob.pbData = ptr::null_mut();
        blob.cbData = 0;
        value
    }

    pub fn protect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
        let input = input_blob(bytes)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        let protected = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if protected == 0 {
            return Err(format!(
                "Windows DPAPI failed to protect the catalog payload: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(take_output_blob(&mut output))
    }

    pub fn unprotect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
        let input = input_blob(bytes)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        let unprotected = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if unprotected == 0 {
            return Err(format!(
                "Windows DPAPI failed to unprotect the catalog payload: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(take_output_blob(&mut output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_protected_payloads_fail_to_decode() {
        assert!(unprotect_string("not base64").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn round_trips_strings_with_windows_dpapi() {
        let protected = protect_string("{\"connections\":[]}").expect("catalog should protect");
        assert_ne!(protected, "{\"connections\":[]}");
        assert_eq!(
            unprotect_string(&protected).expect("catalog should unprotect"),
            "{\"connections\":[]}"
        );
    }
}
