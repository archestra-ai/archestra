//! `archestra`: the program a user runs on their own computer to connect it
//! to Archestra.
//!
//! Each component of the program is a module: [`bridge`] is the MCP bridge
//! (the tunnel client). [`layout`] has the files that the program keeps in
//! the home folder of the user, [`shell_path`] puts the program on the `PATH`,
//! [`update`] brings the program to the one that Archestra serves, and
//! [`uninstall`] removes the program with all its components.

pub mod bridge;
pub mod layout;
pub mod program;
pub mod shell_path;
pub mod uninstall;
pub mod update;
