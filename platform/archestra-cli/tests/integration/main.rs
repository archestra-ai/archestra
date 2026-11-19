//! Integration tests: the run loop of the tunnel client against a mock
//! Archestra (inside the test) and the test MCP servers in `tests/fixtures`.
//!
//! The tests use temp folders only. They do not read the home folder, do not
//! add a start at login, and do not open a browser. Python (`python3`, or
//! `python` on Windows) is the only external program.

mod bridge_control;
mod harness;
mod mock_control_plane;
mod sign_in;
mod tunnel;
mod uninstall;
mod update;
