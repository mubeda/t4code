use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use serde_json::Value;

pub const DEFAULT_TRACE_RECORD_CAPACITY: usize = 256;

#[derive(Clone)]
pub struct BrowserTraceCollector {
    records: Arc<Mutex<VecDeque<Value>>>,
    capacity: usize,
}

impl Default for BrowserTraceCollector {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_TRACE_RECORD_CAPACITY)
    }
}

impl BrowserTraceCollector {
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            records: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity,
        }
    }

    pub fn record(&self, records: Vec<Value>) {
        let mut stored = self.records.lock().expect("trace collector");
        for record in records {
            if self.capacity == 0 {
                break;
            }
            if stored.len() == self.capacity {
                stored.pop_front();
            }
            stored.push_back(record);
        }
    }

    pub fn record_payload(&self, payload: Value) {
        self.record(vec![payload]);
    }

    #[must_use]
    pub fn records(&self) -> Vec<Value> {
        self.records
            .lock()
            .expect("trace collector")
            .iter()
            .cloned()
            .collect()
    }
}
