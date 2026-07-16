use serde_json::Value;

#[test]
fn terminal_wire_fixture_keeps_effect_rpc_method_and_stream_names() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/terminal-rpc-wire.json"))
        .expect("terminal RPC fixture should be valid JSON");

    assert_eq!(fixture["methods"].as_array().map(Vec::len), Some(7));
    assert_eq!(fixture["methods"][0], "terminal.open");
    assert_eq!(fixture["methods"][1], "terminal.attach");
    assert_eq!(fixture["streams"][0], "subscribeTerminalEvents");
    assert_eq!(fixture["streams"][1], "subscribeTerminalMetadata");
    assert_eq!(fixture["attachSnapshot"]["type"], "snapshot");
    assert_eq!(
        fixture["attachSnapshot"]["snapshot"]["terminalId"],
        "term-1"
    );
}
