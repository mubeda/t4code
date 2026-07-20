use std::{
    ffi::{OsStr, OsString},
    fmt,
    future::Future,
    io,
    pin::Pin,
    process::ExitStatus,
};

use process_wrap::tokio::{ChildWrapper, CommandWrap, CommandWrapper, CreationFlags};
use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    },
    System::Threading::{
        CreateEventW, GetProcessId, OpenThread, ResumeThread, SetEvent, THREAD_SUSPEND_RESUME,
    },
};

pub(crate) struct WindowsBatchLaunchGate {
    handle: HANDLE,
    ready_handle: HANDLE,
    name: OsString,
    ready_name: OsString,
}

// SAFETY: event handles can be signalled, waited on, and closed from any thread.
unsafe impl Send for WindowsBatchLaunchGate {}
// SAFETY: SetEvent is thread-safe for a live event handle.
unsafe impl Sync for WindowsBatchLaunchGate {}

impl WindowsBatchLaunchGate {
    pub(crate) fn new() -> io::Result<Self> {
        let identifier = format!(
            "Local\\T4CodeBatchLaunch-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let name = identifier.clone();
        let ready_name = format!("{identifier}-ready");
        let wide_name = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
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

impl Drop for WindowsBatchLaunchGate {
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

#[derive(Debug, Default)]
pub(crate) struct BackgroundJob {
    pending: Option<WindowsJob>,
}

impl CommandWrapper for BackgroundJob {
    fn pre_spawn(
        &mut self,
        command: &mut Command,
        core: &CommandWrap,
    ) -> io::Result<()> {
        let mut flags = windows::Win32::System::Threading::CREATE_SUSPENDED;
        if let Some(CreationFlags(user_flags)) = core.get_wrap::<CreationFlags>() {
            flags |= *user_flags;
        }
        command.creation_flags(flags.0);
        Ok(())
    }

    fn post_spawn(
        &mut self,
        _command: &mut Command,
        child: &mut Child,
        _core: &CommandWrap,
    ) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("child process handle is unavailable"))?;
        match WindowsJob::attach(process.cast()) {
            Ok(job) => {
                if let Err(error) = resume_process_threads(process.cast()) {
                    let _ = job.terminate();
                    let _ = child.start_kill();
                    return Err(error);
                }
                self.pending = Some(job);
                Ok(())
            }
            Err(error) => {
                let _ = child.start_kill();
                Err(error)
            }
        }
    }

    fn wrap_child(
        &mut self,
        inner: Box<dyn ChildWrapper>,
        _core: &CommandWrap,
    ) -> io::Result<Box<dyn ChildWrapper>> {
        let job = self
            .pending
            .take()
            .ok_or_else(|| io::Error::other("background job was not attached after spawn"))?;
        Ok(Box::new(BackgroundJobChild { inner, job }))
    }
}

fn resume_process_threads(process: HANDLE) -> io::Result<()> {
    // SAFETY: `process` is the live handle returned for the newly spawned child.
    let process_id = unsafe { GetProcessId(process) };
    if process_id == 0 {
        return Err(last_os_error());
    }
    // SAFETY: this requests a snapshot of all threads and returns an owned handle.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_os_error());
    }

    let result = resume_process_threads_from_snapshot(process_id, snapshot);
    // SAFETY: this function owns the snapshot handle.
    unsafe { CloseHandle(snapshot) };
    result
}

fn resume_process_threads_from_snapshot(process_id: u32, snapshot: HANDLE) -> io::Result<()> {
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..THREADENTRY32::default()
    };
    let mut resumed = false;
    // SAFETY: `snapshot` is a thread snapshot and `entry` has the required size.
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) };
    while has_entry != 0 {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: the thread id came from the live snapshot.
            let thread =
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(last_os_error());
            }
            // SAFETY: `thread` is a live handle with suspend/resume access.
            let resume_result = unsafe { ResumeThread(thread) };
            let resume_error = (resume_result == u32::MAX).then(last_os_error);
            // SAFETY: this function owns the opened thread handle.
            unsafe { CloseHandle(thread) };
            if let Some(error) = resume_error {
                return Err(error);
            }
            resumed = true;
        }
        // SAFETY: the snapshot and entry remain valid across enumeration.
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    if resumed {
        Ok(())
    } else {
        Err(io::Error::other(
            "suspended child process did not expose a resumable thread",
        ))
    }
}

#[derive(Debug)]
struct BackgroundJobChild {
    inner: Box<dyn ChildWrapper>,
    job: WindowsJob,
}

impl ChildWrapper for BackgroundJobChild {
    fn inner(&self) -> &dyn ChildWrapper {
        &*self.inner
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        &mut *self.inner
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        let Self { inner, job } = *self;
        let _ = job.into_raw();
        inner
    }

    fn start_kill(&mut self) -> io::Result<()> {
        self.job.terminate()
    }

    fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
        self.inner.wait()
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
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

    #[tokio::test]
    async fn job_handle_debug_raw_conversion_and_termination_are_operational() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping 127.0.0.1 -n 30 >nul"])
            .spawn()
            .expect("fixture child should start");
        let process = child.raw_handle().expect("fixture child handle");
        let job = WindowsJob::attach(process.cast()).expect("job should attach");
        assert!(format!("{job:?}").starts_with("WindowsJob("));
        job.terminate().expect("job should terminate");
        child.wait().await.expect("terminated child should wait");

        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping 127.0.0.1 -n 30 >nul"])
            .spawn()
            .expect("raw fixture child should start");
        let process = child.raw_handle().expect("raw fixture child handle");
        let raw = WindowsJob::attach(process.cast())
            .expect("raw job should attach")
            .into_raw();
        // SAFETY: `into_raw` transfers the live job handle to this test.
        unsafe { CloseHandle(raw) };
        child.wait().await.expect("closed job child should wait");

        let _ = last_os_error();
    }
}
