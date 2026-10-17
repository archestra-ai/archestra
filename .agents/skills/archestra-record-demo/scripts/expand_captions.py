"""Expand `- caption: "text"` storyboard actions into shot-scraper `js:` actions.

The caption is a fixed overlay at the bottom of the viewport. It is re-created
on demand, so it survives full page loads (`open:`) as long as each scene sets
its own caption. The text lives in a CSS ::after `content`, not the DOM, so
`text=` selectors in the storyboard never match the caption itself.
"""

import json
import sys

import yaml

CAPTION_JS = """(t => {
  let e = document.getElementById('demo-caption');
  if (!e) {
    const s = document.createElement('style');
    s.textContent = '#demo-caption{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);'
      + 'max-width:80%;padding:10px 18px;border-radius:8px;background:rgba(0,0,0,.8);color:#fff;'
      + 'font:500 20px/1.35 system-ui,sans-serif;text-align:center;z-index:2147483647;pointer-events:none}'
      + '#demo-caption::after{content:attr(data-text)}#demo-caption[data-text=""]{display:none}';
    e = document.createElement('div');
    e.id = 'demo-caption';
    document.head.appendChild(s);
    document.body.appendChild(e);
  }
  e.dataset.text = t;
})(__TEXT__)"""


def expand(actions):
    return [
        {"js": CAPTION_JS.replace("__TEXT__", json.dumps(a["caption"]))}
        if isinstance(a, dict) and "caption" in a
        else a
        for a in actions or []
    ]


board = yaml.safe_load(open(sys.argv[1]))
for scene in board.get("scenes", []):
    scene["do"] = expand(scene.get("do"))
yaml.safe_dump(board, sys.stdout, sort_keys=False, allow_unicode=True)
