#!/usr/bin/env python3
"""Tell IndexNow search engines (Bing, Yandex, Seznam, Naver…) about every page
in the live sitemap. Run after each deploy:  python tools/indexnow.py <site-url>"""

import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import yaml

site_url = sys.argv[1].rstrip("/") + "/"
key = (yaml.safe_load(Path("site.yml").read_text()) or {}).get("indexnow_key")
if not key:
    sys.exit("No indexnow_key in site.yml — skipping.")

sitemap = ""
for attempt in range(6):  # the fresh deploy can take a moment to go live
    try:
        with urllib.request.urlopen(site_url + "sitemap.xml", timeout=20) as r:
            sitemap = r.read().decode()
        with urllib.request.urlopen(f"{site_url}{key}.txt", timeout=20) as r:
            if r.read().decode().strip() == key:
                break
    except OSError as exc:
        print(f"waiting for site ({exc})")
    time.sleep(10)
else:
    sys.exit("Site not reachable yet — skipping this time.")

urls = re.findall(r"<loc>([^<]+)</loc>", sitemap)
urls = [u for u in urls if not u.endswith((".jpg", ".png"))][:10000]
body = json.dumps({
    "host": urlsplit(site_url).hostname,
    "key": key,
    "keyLocation": f"{site_url}{key}.txt",
    "urlList": urls,
}).encode()
req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body,
                             headers={"Content-Type": "application/json; charset=utf-8"})
with urllib.request.urlopen(req, timeout=30) as r:
    print(f"IndexNow: submitted {len(urls)} URLs → HTTP {r.status}")
