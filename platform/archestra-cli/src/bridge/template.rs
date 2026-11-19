//! The variables of a command: `$USER`, `${USER}`, `$HOME` and `${HOME}`, and
//! the Windows names `%USERNAME%` and `%USERPROFILE%` for the same two values.
//!
//! An admin writes one command for all devices, for example
//! `/Users/$USER/bins/mcp`. Each device replaces the variables with its own
//! values. On Windows the user is `USERNAME` and the home folder is
//! `USERPROFILE`; each form works on each system.

/// The values of the variables on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Variables {
    /// The login name of the user. `None`: `$USER` stays as it is.
    pub user: Option<String>,
    /// The home folder of the user. `None`: `$HOME` stays as it is.
    pub home: Option<String>,
}

impl Variables {
    /// Reads the values from the environment of the tunnel client.
    pub(crate) fn of_this_device() -> Self {
        Self {
            user: std::env::var(USER_VARIABLE)
                .ok()
                .filter(|user| !user.is_empty()),
            // `USERPROFILE` on Windows, `HOME` elsewhere.
            home: std::env::home_dir().and_then(|home| home.to_str().map(str::to_owned)),
        }
    }

    /// Replaces the variables in one argument of a command. The command is
    /// split into arguments first, so a value with a space stays in one
    /// argument. A `$NAME` that is not a variable stays as it is.
    pub(crate) fn expand(&self, argument: &str) -> String {
        let mut expanded = String::with_capacity(argument.len());
        let mut rest = argument;
        while let Some(start) = rest.find(['$', '%']) {
            expanded.push_str(&rest[..start]);
            let marker = &rest[start..=start];
            let after = &rest[start + 1..];
            let reference = if marker == "$" {
                Reference::at_start_of(after)
            } else {
                Reference::windows_at_start_of(after)
            };
            let Some(reference) = reference else {
                expanded.push_str(marker);
                rest = after;
                continue;
            };
            match self.value(reference.name) {
                Some(value) => expanded.push_str(value),
                None => expanded.push_str(&rest[start..=start + reference.len]),
            }
            rest = &after[reference.len..];
        }
        expanded.push_str(rest);
        expanded
    }

    fn value(&self, name: &str) -> Option<&str> {
        match name {
            "USER" => self.user.as_deref(),
            "HOME" => self.home.as_deref(),
            _ => None,
        }
    }
}

/// The environment variable with the login name of the user.
#[cfg(windows)]
const USER_VARIABLE: &str = "USERNAME";
#[cfg(not(windows))]
const USER_VARIABLE: &str = "USER";

/// A `NAME` or `{NAME}` that comes after a `$`, or a `NAME%` that comes
/// after a `%`.
struct Reference<'a> {
    name: &'a str,
    /// The number of bytes after the `$` or `%` that the reference takes.
    len: usize,
}

impl<'a> Reference<'a> {
    /// `USERNAME%` or `USERPROFILE%`, the Windows names of `USER` and
    /// `HOME`. Only these two are variables, so `100%` or `%PATH%` stay as
    /// they are.
    fn windows_at_start_of(text: &'a str) -> Option<Self> {
        let windows_name = &text[..text.find('%')?];
        let name = match windows_name {
            "USERNAME" => "USER",
            "USERPROFILE" => "HOME",
            _ => return None,
        };
        Some(Self {
            name,
            len: windows_name.len() + 1,
        })
    }

    fn at_start_of(text: &'a str) -> Option<Self> {
        if let Some(braced) = text.strip_prefix('{') {
            let name = &braced[..braced.find('}')?];
            return is_name(name).then_some(Self {
                name,
                len: name.len() + 2,
            });
        }
        let end = text
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(text.len());
        let name = &text[..end];
        is_name(name).then_some(Self {
            name,
            len: name.len(),
        })
    }
}

/// The form of a shell variable name: letters, digits and `_`, with no digit
/// at the start.
fn is_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables() -> Variables {
        Variables {
            user: Some("anna".to_owned()),
            home: Some("/Users/anna maria".to_owned()),
        }
    }

    #[test]
    fn replaces_both_forms_of_both_variables() {
        let variables = variables();
        assert_eq!(
            variables.expand("/Users/$USER/bins/mcp"),
            "/Users/anna/bins/mcp"
        );
        assert_eq!(
            variables.expand("/Users/${USER}/bins/mcp"),
            "/Users/anna/bins/mcp"
        );
        assert_eq!(variables.expand("$HOME/bin"), "/Users/anna maria/bin");
        assert_eq!(variables.expand("${HOME}bin"), "/Users/anna mariabin");
        assert_eq!(variables.expand("$USER$HOME"), "anna/Users/anna maria");
        assert_eq!(variables.expand("--user=$USER,${USER}"), "--user=anna,anna");
    }

    #[test]
    fn replaces_the_windows_names() {
        let variables = Variables {
            user: Some("anna".to_owned()),
            home: Some(r"C:\Users\anna maria".to_owned()),
        };
        assert_eq!(
            variables.expand(r"%USERPROFILE%\bins\mcp.exe"),
            r"C:\Users\anna maria\bins\mcp.exe"
        );
        assert_eq!(
            variables.expand(r"C:\Users\%USERNAME%\mcp.exe"),
            r"C:\Users\anna\mcp.exe"
        );
        // The same values as `$USER` and `$HOME`; the forms mix.
        assert_eq!(variables.expand("%USERNAME%/$USER"), "anna/anna");
        assert_eq!(
            variables.expand("$HOME%USERPROFILE%"),
            r"C:\Users\anna mariaC:\Users\anna maria"
        );
    }

    #[test]
    fn a_percent_that_is_not_a_windows_variable_stays() {
        let variables = variables();
        for argument in [
            "%PATH%",
            "%USER%",
            "%HOME%",
            "%username%",
            "%USERNAME",
            "100%",
            "%%",
            "%",
            "50% of %USERPROFILE",
        ] {
            assert_eq!(variables.expand(argument), argument, "{argument:?}");
        }
        assert_eq!(variables.expand("100%%USERNAME%"), "100%anna");
        assert_eq!(variables.expand("%PATH%USERNAME%"), "%PATHanna");
    }

    #[test]
    fn a_name_that_is_not_a_variable_stays() {
        let variables = variables();
        for argument in [
            "$USERNAME",
            "$HOMEDIR",
            "$USER_",
            "$PATH",
            "${PATH}",
            "${USER",
            "${}",
            "${US ER}",
            "$",
            "$$",
            "$1",
            "$-USER",
            "price: 5$",
            "no variables",
            "",
        ] {
            assert_eq!(variables.expand(argument), argument, "{argument:?}");
        }
        // The `$` before a variable is not a part of it.
        assert_eq!(variables.expand("$$USER"), "$anna");
        assert_eq!(variables.expand("${PATH}$USER"), "${PATH}anna");
    }

    #[test]
    fn text_that_is_not_ascii_stays() {
        assert_eq!(variables().expand("é$USERé/日本"), "éannaé/日本");
        assert_eq!(variables().expand("$日本"), "$日本");
    }

    #[test]
    fn a_value_is_not_expanded_again() {
        let variables = Variables {
            user: Some("$HOME".to_owned()),
            home: Some("/h".to_owned()),
        };
        assert_eq!(variables.expand("$USER/$HOME"), "$HOME//h");
    }

    #[test]
    fn a_variable_with_no_value_stays() {
        let variables = Variables {
            user: None,
            home: None,
        };
        assert_eq!(
            variables.expand("/Users/$USER/${HOME}"),
            "/Users/$USER/${HOME}"
        );
        assert_eq!(
            variables.expand(r"%USERPROFILE%\%USERNAME%"),
            r"%USERPROFILE%\%USERNAME%"
        );
    }
}
