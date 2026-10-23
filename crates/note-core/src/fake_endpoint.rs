//! 一个假端点：**它把每次收到的请求体记下来**。
//!
//! 为什么要有它：隐私那一档的验收是"私密那篇的字节不许出网"，而这一条
//! **不能用"查出来没有"来证明**——查出来没有只说明检索那一步没捞到它，
//! 说不出"送出去的那份里有没有它"。真的发一次请求、真的看一遍请求体，
//! 才是这条门的样子（docs/02 §嵌入那段"取证"讲的是同一件事）。
//!
//! 它只回一种东西：一句引用了 `[K1]` 的答案，外加 usage。
//! **只记请求体，不记请求头**——请求头里有 Authorization，那把 Key 一个字节都不该
//! 落到用例能读的地方。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// 跑在后台线程里的假端点。`起` 之后它就一直在听，测试结束随进程一起走。
pub struct 假端点 {
    地址: String,
    收到: Arc<Mutex<Vec<String>>>,
}

impl 假端点 {
    /// 起一个假端点。`回包` 是它对每个请求的回应。
    pub fn 起(回包: &str) -> Self {
        let 监听 = TcpListener::bind("127.0.0.1:0").expect("假端点起不来");
        let 端口 = 监听.local_addr().expect("假端点拿不到自己的地址").port();
        let 收到 = Arc::new(Mutex::new(Vec::new()));
        let 罐 = 收到.clone();
        let 回包 = 回包.to_string();
        std::thread::spawn(move || {
            for 进 in 监听.incoming() {
                let Ok(mut 流) = 进 else { continue };
                罐.lock().unwrap().push(读请求体(&mut 流));
                let 答 = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    回包.len(),
                    回包
                );
                let _ = 流.write_all(答.as_bytes());
                let _ = 流.flush();
            }
        });
        Self {
            地址: format!("http://127.0.0.1:{端口}/v1"),
            收到,
        }
    }

    /// 它能接的地址（填到 `base_url` 里）。
    pub fn 地址(&self) -> String {
        self.地址.clone()
    }

    /// 它收到的每个请求体，按先后。
    pub fn 收到(&self) -> Vec<String> {
        self.收到.lock().unwrap().clone()
    }
}

/// 读一个 HTTP 请求的**体**。只认 `Content-Length`——reqwest 发 JSON 用的就是它，
/// 而要支持 chunked 就得写一个解析器，那不是这条用例要的东西。
fn 读请求体(流: &mut TcpStream) -> String {
    let mut 全: Vec<u8> = Vec::new();
    let mut 块 = [0u8; 4096];
    // 先读到头结束（头尾是 \r\n\r\n）
    let 头长 = loop {
        let n = 流.read(&mut 块).unwrap_or(0);
        if n == 0 {
            return String::new();
        }
        全.extend_from_slice(&块[..n]);
        if let Some(i) = 找(&全, b"\r\n\r\n") {
            break i + 4;
        }
    };
    let 头 = String::from_utf8_lossy(&全[..头长]).to_lowercase();
    let 要读: usize = 头
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    while 全.len() < 头长 + 要读 {
        let n = 流.read(&mut 块).unwrap_or(0);
        if n == 0 {
            break;
        }
        全.extend_from_slice(&块[..n]);
    }
    let 体 = 全.get(头长..).unwrap_or(&[]);
    String::from_utf8_lossy(体).to_string()
}

/// 找一段字节在另一段里的位置。
fn 找(hay: &[u8], 针: &[u8]) -> Option<usize> {
    hay.windows(针.len()).position(|w| w == 针)
}
