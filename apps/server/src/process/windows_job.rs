use std::{fmt, future::Future, io, pin::Pin, process::ExitStatus};

use process_wrap::tokio::{ChildWrapper, CommandWrap, CommandWrapper};
use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    },
};

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
