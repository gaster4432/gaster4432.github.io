//! peek-signal mailbox — the same v4 protocol the browser uses.
//!
//! HTTP-only, zero dependencies beyond ureq/serde_json. The mailbox is a
//! message room keyed by a server-issued code; members poll it for messages.

use std::time::Duration;

use serde_json::{json, Value};

pub const SIGNAL: &str = "https://peek-signal.duckdns.org:25789";

const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const LONG_POLL: Duration = Duration::from_secs(25);

fn agent(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build();
    config.into()
}

fn read_json(resp: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, String> {
    let resp = resp.map_err(|e| format!("http: {e}"))?;
    resp.into_body()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("json: {e}"))
}

fn check(out: &Value) -> Result<(), String> {
    if let Some(err) = out.get("error").and_then(|e| e.as_str()) {
        return Err(format!("mailbox error: {err}"));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub enum Event {
    Answer { sdp: String },
    Ice { mline: u32, candidate: String },
    /// A joiner (re)joined; the host must re-create its offer.
    Ready { negotiation: u32 },
    Bye,
}

pub struct Room {
    pub code: String,
    pub negotiation: u32,
    sid: String,
    attempt: String,
}

fn msg_to_event(v: &Value) -> Option<Event> {
    match v.get("t")?.as_str()? {
        "answer" => Some(Event::Answer {
            sdp: v.get("data")?.get("sdp")?.as_str()?.to_owned(),
        }),
        "ice" => Some(Event::Ice {
            mline: v
                .get("data")
                .and_then(|d| d.get("sdpMLineIndex"))
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as u32,
            candidate: v.get("data")?.get("candidate")?.as_str()?.to_owned(),
        }),
        "ready" => Some(Event::Ready {
            negotiation: v.get("negotiation").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
        }),
        "bye" => Some(Event::Bye),
        _ => None,
    }
}

impl Room {
    /// Server-issued code. Role is `host` — the deck shares; browsers watch.
    pub fn create(sid: &str) -> Result<Self, String> {
        let url = format!("{SIGNAL}/room/create?role=host&sid={sid}");
        let resp = read_json(
            agent(REQ_TIMEOUT)
                .post(&url)
                .header("Content-Type", "application/json")
                .send_json(json!({})),
        )?;
        check(&resp)?;
        Ok(Room {
            code: resp["code"].as_str().ok_or("missing code")?.to_owned(),
            negotiation: resp["negotiation"].as_u64().unwrap_or(0) as u32,
            sid: sid.to_owned(),
            attempt: sid.to_owned(),
        })
    }

    fn url(&self) -> String {
        format!(
            "{SIGNAL}/room?code={}&role=host&sid={}&attempt={}",
            self.code, self.sid, self.attempt
        )
    }

    fn message(&self, msg: Value) -> Result<(), String> {
        let url = self.url();
        let body = json!({
            "a": "message",
            "attempt": self.attempt,
            "negotiation": self.negotiation,
            "msg": msg,
        });
        let resp = read_json(
            agent(REQ_TIMEOUT)
                .post(&url)
                .header("Content-Type", "application/json")
                .send_json(body),
        )?;
        check(&resp)
    }

    pub fn offer(&self, sdp: &str) -> Result<(), String> {
        self.message(json!({
            "t": "offer",
            "data": { "type": "offer", "sdp": sdp },
            "negotiation": self.negotiation,
        }))
    }

    pub fn ice(&self, mline: u32, candidate: &str) -> Result<(), String> {
        self.message(json!({
            "t": "ice",
            "data": { "candidate": candidate, "sdpMLineIndex": mline },
            "negotiation": self.negotiation,
        }))
    }

    pub fn ack(&self) -> Result<(), String> {
        let url = self.url();
        let body = json!({
            "a": "ack",
            "attempt": self.attempt,
            "negotiation": self.negotiation,
        });
        let resp = read_json(
            agent(REQ_TIMEOUT)
                .post(&url)
                .header("Content-Type", "application/json")
                .send_json(body),
        )?;
        check(&resp)
    }

    /// Long-poll for messages. Returns immediately when something arrives;
    /// parks up to ~15s server-side otherwise.
    pub fn poll(&self) -> Result<Vec<Event>, String> {
        let url = self.url();
        let resp = read_json(agent(LONG_POLL).get(&url).call())?;
        check(&resp)?;
        let msgs = resp
            .get("msgs")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(msgs.iter().filter_map(msg_to_event).collect())
    }
}
