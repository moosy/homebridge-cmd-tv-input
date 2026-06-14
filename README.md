# homebridge-cmd-tv-input

Homebridge plugin that creates a virtual **Television** accessory in HomeKit with shell-command-driven input selection.

Each "input" maps to a shell command. Selecting an input in HomeKit runs the corresponding command. Only one input can be active at a time — HomeKit enforces this natively via the Television service.

## Use Cases

- Route a doorbell/intercom call to different phones depending on who's home
- Switch between audio zones or scenes
- Select a mode or profile from a list
- Any "one of N" selection that maps to shell commands

## Installation

Via the Homebridge UI: search for `homebridge-cmd-tv-input`.

Or via npm:
```bash
npm install -g homebridge-cmd-tv-input
```

## Configuration

```json
{
  "platforms": [
    {
      "platform": "CmdTelevision",
      "televisions": [
        {
          "name": "My Selector",
          "state_cmd": "/usr/local/bin/mycommand.sh STATUS",
          "on_cmd":    "/usr/local/bin/mycommand.sh LAST",
          "off_cmd":   "/usr/local/bin/mycommand.sh OFF",
          "set_cmd":   "/usr/local/bin/mycommand.sh",
          "polling_interval": 10,
          "inputs": [
            { "name": "Option1", "label": "First Option" },
            { "name": "Option2", "label": "Second Option" },
            { "name": "Option3", "label": "Third Option",  "cmd": "/usr/local/bin/other.sh special" }
          ]
        }
      ]
    }
  ]
}
```

## Configuration Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Accessory name shown in HomeKit |
| `state_cmd` | ✅ | Command that returns the **internal name** of the active input, or nothing if off |
| `set_cmd` | | Base command for input selection — internal input `name` is appended automatically |
| `on_cmd` | | Command executed when TV is switched on. Should return the internal name of the activated input |
| `off_cmd` | | Command executed when TV is switched off |
| `polling_interval` | | How often `state_cmd` is polled in seconds (default: 10) |
| `timeout` | | Command timeout in ms (default: 3000) |

### Input fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Internal key — no spaces. Passed as argument to `set_cmd`, matched against `state_cmd` output |
| `label` | | Display name in HomeKit — may contain spaces. Defaults to `name` |
| `cmd` | | Custom command for this input — overrides `set_cmd` + `name` |

## How It Works

- The plugin registers a HomeKit **Television** accessory with one **InputSource** per configured input.
- When you select an input in the Home app, `set_cmd <name>` is executed (or the custom `cmd` if set).
- `state_cmd` is polled periodically and should output the **internal name** of the currently active input, or nothing if off.
- HomeKit automatically ensures only one input is active at a time.
- Switching the TV **on** runs `on_cmd` (e.g. restore last state). Switching **off** runs `off_cmd`.

## Example Backend Script

```bash
#!/bin/bash
# /usr/local/bin/mycommand.sh

FLAGFILE=/etc/mycommand-active
LASTFILE=/etc/mycommand-last
DEFAULT="Option1"

case "$1" in
    STATUS)
        [ -f "$FLAGFILE" ] && [ -f "$LASTFILE" ] && cat "$LASTFILE"
        ;;
    OFF)
        rm -f "$FLAGFILE"
        ;;
    LAST)
        NAME=$([ -f "$LASTFILE" ] && cat "$LASTFILE" || echo "$DEFAULT")
        echo "$NAME" > "$FLAGFILE"
        echo "$NAME" > "$LASTFILE"
        echo "$NAME"
        ;;
    *)
        echo "$1" > "$FLAGFILE"
        echo "$1" > "$LASTFILE"
        ;;
esac
```

## Notes

- The Television accessory is published as an **external accessory** and must be paired manually in the Home app the first time: tap **+** → **I Don't Have a Code** → enter your Homebridge PIN.
- Multiple televisions can be configured in one platform instance.
- The virtual TV is shown as "off" when no input is active.

## License

MIT