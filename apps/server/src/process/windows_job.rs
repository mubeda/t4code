use std::{fmt, io};

use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE},
    System::JobObjects::{
        CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    },
};

pub(crate) struct WindowsJob(HANDLE);

// SAFETY: a Windows job handle may be used from any thread, and ownership is
// represented by this type's single close-on-drop handle.
unsafe impl Send for WindowsJob {}
// SAFETY: the Win32 operations used here are thread-safe for job handles.
unsafe impl Sync for WindowsJob {}

impl WindowsJob {
    pub(crate) fn new() -> io::Result<Self> {
        Self::create(std::ptr::null())
    }

    #[cfg(test)]
    pub(crate) fn new_named(name: &[u16]) -> io::Result<Self> {
        Self::create(name.as_ptr())
    }

    fn create(name: *const u16) -> io::Result<Self> {
        // SAFETY: null security attributes request default security. `name` is
        // either null or points to a caller-owned NUL-terminated slice that
        // remains valid for this call.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), name) };
        if handle.is_null() {
            return Err(last_os_error());
        }

        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe `information` for the requested
        // `JobObjectExtendedLimitInformation` class.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&information).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = last_os_error();
            // SAFETY: `handle` was created above and is still owned here.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self(handle))
    }

    pub(crate) fn raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0.cast()
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: `self.0` remains a live job handle for this object's lifetime.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }
}

impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: this type owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

impl fmt::Debug for WindowsJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("WindowsJob").field(&self.0).finish()
    }
}

fn last_os_error() -> io::Error {
    // SAFETY: GetLastError has no preconditions and reads thread-local state.
    io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::CloseHandle;

    #[test]
    fn job_handle_creation_debug_raw_conversion_and_termination_are_operational() {
        let job = WindowsJob::new().expect("job should be created");
        assert!(format!("{job:?}").starts_with("WindowsJob("));
        assert!(!job.raw_handle().is_null());
        job.terminate().expect("job should terminate");

        let raw = WindowsJob::new()
            .expect("raw job should be created")
            .into_raw();
        // SAFETY: `into_raw` transfers the live job handle to this test.
        unsafe { CloseHandle(raw) };

        let _ = last_os_error();
    }
}
