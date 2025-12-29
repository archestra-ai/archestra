---
title: Quickstart
category: Archestra Platform
order: 1
description: Get started with Archestra Platform using Docker
lastUpdated: 2025-10-08
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
Put the screenshot of the main page here as the last step after deployment.
-->

<iframe width="560" height="315" src="https://www.youtube.com/embed/SkmluS-xzmM?si=zjTk5TVzOMpo7sx9&amp;start=1918" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

## Running the Archestra Platform

1. Start with Docker

   ```bash
   docker pull archestra/platform:latest;
   docker run -p 9000:9000 -p 3000:3000 \
      -e ARCHESTRA_QUICKSTART \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v archestra-postgres-data:/var/lib/postgresql/data \
      -v archestra-app-data:/app/data \
      archestra/platform;
   ```

2. Open <http://localhost:3000>

3. The platform is now running with:
   - Web UI at <http://localhost:3000>
   - API proxy at <http://localhost:9000>

![Archestra Platform Chat Interface](/docs/automated_screenshots/platform_chat_interface.png)
