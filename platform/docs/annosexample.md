{
  "tools": [
    {
      "name": "browser_close",
      "description": "Close the page",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Close browser",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_resize",
      "description": "Resize the browser window",
      "inputSchema": {
        "type": "object",
        "properties": {
          "width": {
            "type": "number",
            "description": "Width of the browser window"
          },
          "height": {
            "type": "number",
            "description": "Height of the browser window"
          }
        },
        "required": [
          "width",
          "height"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Resize browser window",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_console_messages",
      "description": "Returns all console messages",
      "inputSchema": {
        "type": "object",
        "properties": {
          "level": {
            "default": "info",
            "description": "Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to \"info\".",
            "type": "string",
            "enum": [
              "error",
              "warning",
              "info",
              "debug"
            ]
          },
          "filename": {
            "description": "Filename to save the console messages to. If not provided, messages are returned as text.",
            "type": "string"
          }
        },
        "required": [
          "level"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Get console messages",
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_handle_dialog",
      "description": "Handle a dialog",
      "inputSchema": {
        "type": "object",
        "properties": {
          "accept": {
            "type": "boolean",
            "description": "Whether to accept the dialog."
          },
          "promptText": {
            "description": "The text of the prompt in case of a prompt dialog.",
            "type": "string"
          }
        },
        "required": [
          "accept"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Handle a dialog",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_evaluate",
      "description": "Evaluate JavaScript expression on page or element",
      "inputSchema": {
        "type": "object",
        "properties": {
          "function": {
            "type": "string",
            "description": "() => { /* code */ } or (element) => { /* code */ } when element is provided"
          },
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "ref": {
            "description": "Exact target element reference from the page snapshot",
            "type": "string"
          }
        },
        "required": [
          "function"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Evaluate JavaScript",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_file_upload",
      "description": "Upload one or multiple files",
      "inputSchema": {
        "type": "object",
        "properties": {
          "paths": {
            "description": "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Upload files",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_fill_form",
      "description": "Fill multiple form fields",
      "inputSchema": {
        "type": "object",
        "properties": {
          "fields": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "Human-readable field name"
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "textbox",
                    "checkbox",
                    "radio",
                    "combobox",
                    "slider"
                  ],
                  "description": "Type of the field"
                },
                "ref": {
                  "type": "string",
                  "description": "Exact target field reference from the page snapshot"
                },
                "value": {
                  "type": "string",
                  "description": "Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option."
                }
              },
              "required": [
                "name",
                "type",
                "ref",
                "value"
              ],
              "additionalProperties": false
            },
            "description": "Fields to fill in"
          }
        },
        "required": [
          "fields"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Fill form",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_install",
      "description": "Install the browser specified in the config. Call this if you get an error about the browser not being installed.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Install the browser specified in the config",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_press_key",
      "description": "Press a key on the keyboard",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "description": "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
          }
        },
        "required": [
          "key"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Press a key",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_type",
      "description": "Type text into editable element",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "ref": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot"
          },
          "text": {
            "type": "string",
            "description": "Text to type into the element"
          },
          "submit": {
            "description": "Whether to submit entered text (press Enter after)",
            "type": "boolean"
          },
          "slowly": {
            "description": "Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.",
            "type": "boolean"
          }
        },
        "required": [
          "ref",
          "text"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Type text",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_navigate",
      "description": "Navigate to a URL",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to navigate to"
          }
        },
        "required": [
          "url"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Navigate to a URL",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_navigate_back",
      "description": "Go back to the previous page in the history",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Go back",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_network_requests",
      "description": "Returns all network requests since loading the page",
      "inputSchema": {
        "type": "object",
        "properties": {
          "includeStatic": {
            "default": false,
            "description": "Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.",
            "type": "boolean"
          },
          "filename": {
            "description": "Filename to save the network requests to. If not provided, requests are returned as text.",
            "type": "string"
          }
        },
        "required": [
          "includeStatic"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "List network requests",
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_run_code",
      "description": "Run Playwright code snippet",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "description": "A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction. For example: `async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }`"
          }
        },
        "required": [
          "code"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Run Playwright code",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_take_screenshot",
      "description": "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "type": {
            "default": "png",
            "description": "Image format for the screenshot. Default is png.",
            "type": "string",
            "enum": [
              "png",
              "jpeg"
            ]
          },
          "filename": {
            "description": "File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg}` if not specified. Prefer relative file names to stay within the output directory.",
            "type": "string"
          },
          "element": {
            "description": "Human-readable element description used to obtain permission to screenshot the element. If not provided, the screenshot will be taken of viewport. If element is provided, ref must be provided too.",
            "type": "string"
          },
          "ref": {
            "description": "Exact target element reference from the page snapshot. If not provided, the screenshot will be taken of viewport. If ref is provided, element must be provided too.",
            "type": "string"
          },
          "fullPage": {
            "description": "When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.",
            "type": "boolean"
          }
        },
        "required": [
          "type"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Take a screenshot",
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_snapshot",
      "description": "Capture accessibility snapshot of the current page, this is better than screenshot",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filename": {
            "description": "Save snapshot to markdown file instead of returning it in the response.",
            "type": "string"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Page snapshot",
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_click",
      "description": "Perform click on a web page",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "ref": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot"
          },
          "doubleClick": {
            "description": "Whether to perform a double click instead of a single click",
            "type": "boolean"
          },
          "button": {
            "description": "Button to click, defaults to left",
            "type": "string",
            "enum": [
              "left",
              "right",
              "middle"
            ]
          },
          "modifiers": {
            "description": "Modifier keys to press",
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "Alt",
                "Control",
                "ControlOrMeta",
                "Meta",
                "Shift"
              ]
            }
          }
        },
        "required": [
          "ref"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Click",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_drag",
      "description": "Perform drag and drop between two elements",
      "inputSchema": {
        "type": "object",
        "properties": {
          "startElement": {
            "type": "string",
            "description": "Human-readable source element description used to obtain the permission to interact with the element"
          },
          "startRef": {
            "type": "string",
            "description": "Exact source element reference from the page snapshot"
          },
          "endElement": {
            "type": "string",
            "description": "Human-readable target element description used to obtain the permission to interact with the element"
          },
          "endRef": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot"
          }
        },
        "required": [
          "startElement",
          "startRef",
          "endElement",
          "endRef"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Drag mouse",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_hover",
      "description": "Hover over element on page",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "ref": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot"
          }
        },
        "required": [
          "ref"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Hover mouse",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_select_option",
      "description": "Select an option in a dropdown",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "ref": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot"
          },
          "values": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Array of values to select in the dropdown. This can be a single value or multiple values."
          }
        },
        "required": [
          "ref",
          "values"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Select option",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_tabs",
      "description": "List, create, close, or select a browser tab.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "list",
              "new",
              "close",
              "select"
            ],
            "description": "Operation to perform"
          },
          "index": {
            "description": "Tab index, used for close/select. If omitted for close, current tab is closed.",
            "type": "number"
          }
        },
        "required": [
          "action"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Manage tabs",
        "readOnlyHint": false,
        "destructiveHint": true,
        "openWorldHint": true
      }
    },
    {
      "name": "browser_wait_for",
      "description": "Wait for text to appear or disappear or a specified time to pass",
      "inputSchema": {
        "type": "object",
        "properties": {
          "time": {
            "description": "The time to wait in seconds",
            "type": "number"
          },
          "text": {
            "description": "The text to wait for",
            "type": "string"
          },
          "textGone": {
            "description": "The text to wait for to disappear",
            "type": "string"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "annotations": {
        "title": "Wait for",
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": true
      }
    }
  ]
}