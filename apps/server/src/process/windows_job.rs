use std::{
    ffi::{OsStr, OsString},
    fmt,
    io,
};

use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    },
    System::Threading::{CreateEventW, SetEvent},
};

pub(crate) struct WindowsPtyLaunchGate {
    handle: HANDLE,
    ready_handle: HANDLE,
    name: OsString,
    ready_name: OsString,
}

// SAFETY: event handles can be signalled, waited on, and closed from any thread.
unsafe impl Send for WindowsPtyLaunchGate {}
// SAFETY: SetEvent is thread-safe for a live event handle.
unsafe impl Sync for WindowsPtyLaunchGate {}

impl WindowsPtyLaunchGate {
    pub(crate) fn new() -> io::Result<Self> {
        let identifier = format!(
            "Local\\T4CodePtyLaunch-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let name = identifier.clone();
        let ready_name = format!("{identifier}-ready");
        let wide_name = name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: default security, a manual-reset nonsignalled event, and a
        // NUL-terminated name are valid CreateEventW inputs.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide_name.as_ptr()) };
        if handle.is_null() {
            return Err(last_os_error());
        }
        let wide_ready_name = ready_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: default security, a manual-reset nonsignalled event, and a
        // NUL-terminated name are valid CreateEventW inputs.
        let ready_handle =
            unsafe { CreateEventW(std::ptr::null(), 1, 0, wide_ready_name.as_ptr()) };
        if ready_handle.is_null() {
            let error = last_os_error();
            // SAFETY: this function owns the gate handle created above.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self {
            handle,
            ready_handle,
            name: name.into(),
            ready_name: ready_name.into(),
        })
    }

    pub(crate) fn name(&self) -> &OsStr {
        &self.name
    }

    pub(crate) fn ready_name(&self) -> &OsStr {
        &self.ready_name
    }

    pub(crate) fn signal(&self) -> io::Result<()> {
        // SAFETY: this type owns a live event handle.
        if unsafe { SetEvent(self.handle) } == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for WindowsPtyLaunchGate {
    fn drop(&mut self) {
        // SAFETY: this type owns both handles and closes each exactly once.
        unsafe { CloseHandle(self.ready_handle) };
        unsafe { CloseHandle(self.handle) };
    }
}

pub(crate) struct WindowsJob(HANDLE);

// SAFETY: a Windows job handle may be used from any thread, and ownership is
// represented by this type's single close-on-drop handle.
unsafe impl Send for WindowsJob {}
// SAFETY: the Win32 operations used here are thread-safe for job handles.
unsafe impl Sync for WindowsJob {}

impl WindowsJob {
    pub(crate) fn attach(process: HANDLE) -> io::Result<Self> {
        // SAFETY: null security attributes and name request an unnamed job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
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

        // SAFETY: both handles are valid and owned by the current process.
        let assigned = unsafe { AssignProcessToJobObject(handle, process) };
        if assigned == 0 {
            let error = last_os_error();
            // SAFETY: `handle` was created above and is still owned here.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self(handle))
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: `self.0` remains a live job handle for this object's lifetime.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
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
    use tokio::process::Command;

    #[tokio::test]
    async fn job_handle_debug_and_termination_are_operational() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping 127.0.0.1 -n 30 >nul"])
            .spawn()
            .expect("fixture child should start");
        let process = child.raw_handle().expect("fixture child handle");
        let job = WindowsJob::attach(process.cast()).expect("job should attach");
        assert!(format!("{job:?}").starts_with("WindowsJob("));
        job.terminate().expect("job should terminate");
        child.wait().await.expect("terminated child should wait");

        let _ = last_os_error();
    }
}
