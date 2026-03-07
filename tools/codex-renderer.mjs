import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const PORT = 3456;
let currentFilePath = path.resolve(process.argv[2] || "d:\\work\\agent_output.jsonl");

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Output Renderer</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Consolas', 'Monaco', monospace;
      background: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding: 15px;
      background: #2d2d2d;
      border-radius: 8px;
    }
    .header h1 { margin: 0; font-size: 18px; color: #569cd6; }
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #4ec9b0;
      animation: pulse 2s infinite;
    }
    .status-dot.paused { background: #ce9178; animation: none; }
    .status-dot.error { background: #f44747; animation: none; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .stats {
      font-size: 12px;
      color: #808080;
    }
    .file-input-row {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      align-items: center;
    }
    .file-input-row label {
      font-size: 13px;
      color: #9cdcfe;
    }
    .file-input-row input {
      flex: 1;
      background: #3c3c3c;
      border: 1px solid #555;
      color: #d4d4d4;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: 'Consolas', monospace;
      font-size: 13px;
    }
    .file-input-row input:focus {
      outline: none;
      border-color: #0e639c;
    }
    .file-input-row .file-status {
      font-size: 11px;
      color: #808080;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-input-row .file-status.ok { color: #4ec9b0; }
    .file-input-row .file-status.error { color: #f44747; }
    .controls {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    button {
      background: #0e639c;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover { background: #1177bb; }
    button.danger { background: #c42b1c; }
    button.danger:hover { background: #d43b2c; }
    button.success { background: #264f36; }
    button.success:hover { background: #2d5a3d; }
    .output-container {
      background: #252526;
      border-radius: 8px;
      padding: 15px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .session-group {
      margin-bottom: 20px;
      border: 1px solid #3c3c3c;
      border-radius: 8px;
      overflow: hidden;
    }
    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 15px;
      background: #2d2d2d;
      cursor: pointer;
      user-select: none;
    }
    .session-header:hover { background: #363636; }
    .session-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .session-id {
      font-size: 13px;
      font-weight: bold;
      color: #dcdcaa;
    }
    .session-role {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      background: #0e639c;
      color: white;
    }
    .session-stats {
      font-size: 11px;
      color: #808080;
    }
    .session-content {
      padding: 10px;
      display: none;
    }
    .session-content.expanded { display: block; }
    .stream-group {
      margin-bottom: 10px;
    }
    .stream-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
      padding-bottom: 3px;
      border-bottom: 1px solid #3c3c3c;
    }
    .stream-label {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: bold;
    }
    .stream-stdout { background: #264f36; color: #4ec9b0; }
    .stream-stderr { background: #4d3a2b; color: #ce9178; }
    .stream-system { background: #2d4a5e; color: #9cdcfe; }
    .stream-response { background: #3c3c50; color: #dcdcaa; }
    .stream-other { background: #4a4a4a; color: #d4d4d4; }
    .stream-content {
      white-space: pre-wrap;
      word-break: break-all;
      font-size: 12px;
      line-height: 1.4;
      max-height: 500px;
      overflow-y: auto;
    }
    .time-block {
      margin-bottom: 8px;
      border-left: 2px solid #3c3c3c;
      padding-left: 10px;
    }
    .time-block-header {
      font-size: 11px;
      color: #569cd6;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .time-block-header .time {
      background: #2d4a5e;
      padding: 1px 6px;
      border-radius: 3px;
    }
    .time-block-header .count {
      color: #808080;
    }
    .line-row {
      display: flex;
      min-height: 18px;
    }
    .line-number {
      color: #858585;
      min-width: 40px;
      text-align: right;
      margin-right: 10px;
      user-select: none;
      font-size: 10px;
      flex-shrink: 0;
    }
    .line-content {
      flex: 1;
    }
    .toggle-icon {
      font-size: 12px;
      color: #808080;
      transition: transform 0.2s;
    }
    .toggle-icon.expanded { transform: rotate(90deg); }
    .loading { color: #808080; font-style: italic; }
    .no-sessions { color: #808080; text-align: center; padding: 20px; }
    
    .diff-block {
      margin: 8px 0;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      overflow: hidden;
      background: #1a1a1a;
    }
    .diff-header {
      background: #2d2d2d;
      padding: 6px 10px;
      font-size: 11px;
      color: #9cdcfe;
      border-bottom: 1px solid #3c3c3c;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .diff-file {
      color: #dcdcaa;
    }
    .diff-stats {
      color: #808080;
    }
    .diff-content {
      padding: 5px 10px;
      font-size: 11px;
      line-height: 1.3;
      overflow-x: auto;
    }
    .diff-line {
      white-space: pre;
      display: flex;
    }
    .diff-line-num {
      color: #606060;
      min-width: 30px;
      text-align: right;
      margin-right: 10px;
      user-select: none;
      font-size: 10px;
    }
    .diff-line-add {
      background: rgba(78, 201, 176, 0.15);
      color: #4ec9b0;
    }
    .diff-line-add .diff-line-num {
      color: #4ec9b0;
    }
    .diff-line-del {
      background: rgba(244, 71, 71, 0.15);
      color: #f44747;
    }
    .diff-line-del .diff-line-num {
      color: #f44747;
    }
    .diff-line-hunk {
      color: #569cd6;
      background: rgba(86, 156, 214, 0.1);
    }
    .diff-line-info {
      color: #808080;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Codex Output Renderer</h1>
    <div class="status">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Running</span>
      <span class="stats" id="stats">Lines: 0 | Sessions: 0</span>
    </div>
  </div>
  
  <div class="file-input-row">
    <label>File:</label>
    <input type="text" id="filePathInput" placeholder="Enter file path..." />
    <button class="success" onclick="openFile()">Open</button>
    <span class="file-status" id="fileStatus"></span>
  </div>
  
  <div class="controls">
    <button id="toggleBtn" onclick="toggleRefresh()">Pause</button>
    <button onclick="expandAll()">Expand All</button>
    <button onclick="collapseAll()">Collapse All</button>
    <button onclick="clearOutput()">Clear</button>
    <button class="danger" onclick="resetAndReload()">Reset</button>
  </div>
  
  <div class="output-container" id="output">
    <div class="loading">Loading...</div>
  </div>

  <script>
    const REFRESH_INTERVAL = 3000;
    const streamOrder = ['system', 'stderr', 'stdout', 'response', 'other'];
    const MERGE_WINDOW_MS = 60 * 1000;
    
    let isRunning = true;
    let lastLineCount = 0;
    let totalLines = 0;
    let intervalId = null;
    let sessionData = {};
    let expandedSessions = new Set();
    let currentFilePath = '';

    async function openFile() {
      const input = document.getElementById('filePathInput');
      const filePath = input.value.trim();
      if (!filePath) return;
      
      const statusEl = document.getElementById('fileStatus');
      statusEl.textContent = 'Opening...';
      statusEl.className = 'file-status';
      
      try {
        const response = await fetch('/open?path=' + encodeURIComponent(filePath));
        const result = await response.json();
        
        if (result.error) {
          statusEl.textContent = result.error;
          statusEl.className = 'file-status error';
          return;
        }
        
        currentFilePath = result.path;
        statusEl.textContent = result.path;
        statusEl.className = 'file-status ok';
        
        resetAndReload();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'file-status error';
      }
    }

    async function loadCurrentFile() {
      try {
        const response = await fetch('/current');
        const result = await response.json();
        if (result.path) {
          currentFilePath = result.path;
          document.getElementById('filePathInput').value = result.path;
          document.getElementById('fileStatus').textContent = result.path;
          document.getElementById('fileStatus').className = 'file-status ok';
        }
      } catch (err) {
        console.error('Failed to load current file:', err);
      }
    }

    async function fetchNewLines() {
      try {
        const response = await fetch('/data?t=' + Date.now());
        if (!response.ok) throw new Error('HTTP ' + response.status);
        
        const text = await response.text();
        if (!text.trim()) {
          totalLines = 0;
          updateStats();
          return;
        }
        
        const lines = text.trim().split('\\n');
        totalLines = lines.length;
        
        if (lines.length > lastLineCount) {
          const newLines = lines.slice(lastLineCount);
          processNewLines(newLines);
          lastLineCount = lines.length;
          updateStats();
        }
      } catch (err) {
        console.error('Fetch error:', err);
      }
    }

    function processNewLines(lines) {
      lines.forEach(line => {
        try {
          const obj = JSON.parse(line);
          const sessionId = obj.sessionId || 'unknown';
          const stream = obj.stream || 'other';
          const content = obj.content || '';
          const timestamp = obj.timestamp || '';
          
          if (!sessionData[sessionId]) {
            sessionData[sessionId] = {
              id: sessionId,
              role: extractRole(sessionId),
              streams: {},
              firstSeen: timestamp,
              lastSeen: timestamp
            };
          }
          
          if (!sessionData[sessionId].streams[stream]) {
            sessionData[sessionId].streams[stream] = [];
          }
          
          sessionData[sessionId].streams[stream].push({
            content,
            timestamp,
            timestampMs: timestamp ? new Date(timestamp).getTime() : 0
          });
          
          if (timestamp) {
            sessionData[sessionId].lastSeen = timestamp;
          }
        } catch (e) {
          const sessionId = 'parse-error';
          if (!sessionData[sessionId]) {
            sessionData[sessionId] = {
              id: sessionId,
              role: 'error',
              streams: {},
              firstSeen: '',
              lastSeen: ''
            };
          }
          if (!sessionData[sessionId].streams.other) {
            sessionData[sessionId].streams.other = [];
          }
          sessionData[sessionId].streams.other.push({ content: line, timestamp: '', timestampMs: 0 });
        }
      });
      
      renderOutput();
    }

    function extractRole(sessionId) {
      if (sessionId.startsWith('sess-')) {
        const match = sessionId.match(/sess-(\\w+)-/);
        if (match) return match[1];
      }
      if (sessionId.includes('dev')) return 'dev';
      if (sessionId.includes('leader')) return 'leader';
      if (sessionId.includes('manager')) return 'manager';
      return sessionId.split('-')[0] || sessionId;
    }

    function formatTime(isoString) {
      if (!isoString) return '';
      try {
        const d = new Date(isoString);
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        return isoString;
      }
    }

    function groupByTimeWindow(items) {
      if (!items || items.length === 0) return [];
      
      const groups = [];
      let currentGroup = null;
      
      items.forEach((item, idx) => {
        const ts = item.timestampMs || 0;
        
        if (!currentGroup) {
          currentGroup = {
            startTime: item.timestamp,
            startTimeMs: ts,
            items: [item]
          };
        } else if (ts > 0 && currentGroup.startTimeMs > 0 && (ts - currentGroup.startTimeMs) <= MERGE_WINDOW_MS) {
          currentGroup.items.push(item);
        } else {
          groups.push(currentGroup);
          currentGroup = {
            startTime: item.timestamp,
            startTimeMs: ts,
            items: [item]
          };
        }
      });
      
      if (currentGroup) {
        groups.push(currentGroup);
      }
      
      return groups;
    }

    function parseDiffBlocks(lines) {
      const blocks = [];
      let currentBlock = null;
      let normalLines = [];
      
      lines.forEach((item, idx) => {
        const content = item.content;
        
        if (content.startsWith('diff --git ') || content.startsWith('diff -')) {
          if (currentBlock) {
            blocks.push({ type: 'diff', data: currentBlock });
            currentBlock = null;
          }
          if (normalLines.length > 0) {
            blocks.push({ type: 'normal', lines: normalLines });
            normalLines = [];
          }
          
          const fileMatch = content.match(/diff --git a\\/(.+?) b\\//);
          const fileName = fileMatch ? fileMatch[1] : 'unknown';
          
          currentBlock = {
            fileName: fileName,
            header: content,
            lines: []
          };
        } else if (currentBlock) {
          if (content.startsWith('@@')) {
            currentBlock.lines.push({ type: 'hunk', content: content });
          } else if (content.startsWith('+') && !content.startsWith('+++')) {
            currentBlock.lines.push({ type: 'add', content: content });
          } else if (content.startsWith('-') && !content.startsWith('---')) {
            currentBlock.lines.push({ type: 'del', content: content });
          } else if (content.startsWith('index ') || content.startsWith('---') || content.startsWith('+++')) {
            currentBlock.lines.push({ type: 'info', content: content });
          } else {
            currentBlock.lines.push({ type: 'ctx', content: content });
          }
        } else {
          normalLines.push(item);
        }
      });
      
      if (currentBlock) {
        blocks.push({ type: 'diff', data: currentBlock });
      } else if (normalLines.length > 0) {
        blocks.push({ type: 'normal', lines: normalLines });
      }
      
      return blocks;
    }

    function renderDiffBlock(block) {
      const d = block.data;
      const addCount = d.lines.filter(l => l.type === 'add').length;
      const delCount = d.lines.filter(l => l.type === 'del').length;
      
      let html = '<div class="diff-block">';
      html += '<div class="diff-header">';
      html += '<span class="diff-file">' + escapeHtml(d.fileName) + '</span>';
      html += '<span class="diff-stats">+' + addCount + ' -' + delCount + '</span>';
      html += '</div>';
      html += '<div class="diff-content">';
      
      d.lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        let lineClass = 'diff-line';
        
        if (line.type === 'add') {
          lineClass += ' diff-line-add';
        } else if (line.type === 'del') {
          lineClass += ' diff-line-del';
        } else if (line.type === 'hunk') {
          lineClass += ' diff-line-hunk';
        } else if (line.type === 'info') {
          lineClass += ' diff-line-info';
        }
        
        html += '<div class="' + lineClass + '">';
        html += '<span class="diff-line-num">' + lineNum + '</span>';
        html += '<span>' + escapeHtml(line.content) + '</span>';
        html += '</div>';
      });
      
      html += '</div></div>';
      return html;
    }

    function renderNormalLines(lines) {
      let html = '';
      lines.forEach((item, idx) => {
        const lineNum = idx + 1;
        const displayNum = String(lineNum).padStart(4, ' ');
        html += '<div class="line-row"><span class="line-number">' + displayNum + '</span><span class="line-content">' + escapeHtml(item.content) + '</span></div>';
      });
      return html;
    }

    function renderStreamWithTimestamps(stream, items) {
      if (stream !== 'system' && stream !== 'stdout') {
        const blocks = parseDiffBlocks(items);
        let html = '';
        blocks.forEach(block => {
          if (block.type === 'diff') {
            html += renderDiffBlock(block);
          } else {
            html += renderNormalLines(block.lines);
          }
        });
        return html;
      }
      
      const timeGroups = groupByTimeWindow(items);
      let html = '';
      
      timeGroups.forEach(group => {
        const timeStr = formatTime(group.startTime);
        const count = group.items.length;
        
        html += '<div class="time-block">';
        html += '<div class="time-block-header">';
        html += '<span class="time">' + timeStr + '</span>';
        html += '<span class="count">' + count + ' lines</span>';
        html += '</div>';
        
        const blocks = parseDiffBlocks(group.items);
        blocks.forEach(block => {
          if (block.type === 'diff') {
            html += renderDiffBlock(block);
          } else {
            html += renderNormalLines(block.lines);
          }
        });
        
        html += '</div>';
      });
      
      return html;
    }

    function renderOutput() {
      const output = document.getElementById('output');
      const sessions = Object.values(sessionData).sort((a, b) => 
        (a.lastSeen || '').localeCompare(b.lastSeen || '')
      );
      
      if (sessions.length === 0) {
        output.innerHTML = '<div class="no-sessions">No session data</div>';
        return;
      }
      
      let html = '';
      
      sessions.forEach(session => {
        const isExpanded = expandedSessions.has(session.id);
        const totalLines = Object.values(session.streams).reduce((sum, arr) => sum + arr.length, 0);
        
        html += '<div class="session-group">';
        html += '<div class="session-header" onclick="toggleSession(\\'' + session.id + '\\')">';
        html += '<div class="session-title">';
        html += '<span class="toggle-icon ' + (isExpanded ? 'expanded' : '') + '">▶</span>';
        html += '<span class="session-id">' + escapeHtml(session.id) + '</span>';
        html += '<span class="session-role">' + escapeHtml(session.role) + '</span>';
        html += '</div>';
        html += '<div class="session-stats">' + totalLines + ' lines</div>';
        html += '</div>';
        
        html += '<div class="session-content ' + (isExpanded ? 'expanded' : '') + '">';
        
        streamOrder.forEach(stream => {
          const items = session.streams[stream];
          if (!items || items.length === 0) return;
          
          const labelClass = 'stream-label stream-' + stream;
          const label = stream.toUpperCase();
          
          html += '<div class="stream-group">';
          html += '<div class="stream-header">';
          html += '<span class="' + labelClass + '">' + label + '</span>';
          html += '<span class="session-stats">' + items.length + ' lines</span>';
          html += '</div>';
          html += '<div class="stream-content">';
          
          html += renderStreamWithTimestamps(stream, items);
          
          html += '</div></div>';
        });
        
        html += '</div></div>';
      });
      
      output.innerHTML = html;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function toggleSession(sessionId) {
      if (expandedSessions.has(sessionId)) {
        expandedSessions.delete(sessionId);
      } else {
        expandedSessions.add(sessionId);
      }
      renderOutput();
    }

    function expandAll() {
      Object.keys(sessionData).forEach(id => expandedSessions.add(id));
      renderOutput();
    }

    function collapseAll() {
      expandedSessions.clear();
      renderOutput();
    }

    function updateStats() {
      const sessionCount = Object.keys(sessionData).length;
      document.getElementById('stats').textContent = 'Lines: ' + totalLines + ' | Sessions: ' + sessionCount;
    }

    function toggleRefresh() {
      isRunning = !isRunning;
      const btn = document.getElementById('toggleBtn');
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      
      if (isRunning) {
        btn.textContent = 'Pause';
        dot.classList.remove('paused');
        text.textContent = 'Running';
        startInterval();
      } else {
        btn.textContent = 'Resume';
        dot.classList.add('paused');
        text.textContent = 'Paused';
        stopInterval();
      }
    }

    function clearOutput() {
      sessionData = {};
      expandedSessions.clear();
      renderOutput();
      updateStats();
    }

    function resetAndReload() {
      lastLineCount = 0;
      totalLines = 0;
      clearOutput();
      fetchNewLines();
    }

    function startInterval() {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(fetchNewLines, REFRESH_INTERVAL);
    }

    function stopInterval() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    document.getElementById('filePathInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        openFile();
      }
    });

    loadCurrentFile();
    fetchNewLines();
    startInterval();
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(HTML_CONTENT);
    return;
  }

  if (reqUrl.pathname === "/current") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: currentFilePath }));
    return;
  }

  if (reqUrl.pathname === "/open") {
    const filePath = reqUrl.searchParams.get("path");
    if (!filePath) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Path parameter required" }));
      return;
    }

    const resolvedPath = path.resolve(filePath);

    try {
      fs.accessSync(resolvedPath, fs.constants.R_OK);
      currentFilePath = resolvedPath;
      console.log(`Switched to file: ${currentFilePath}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ path: currentFilePath }));
    } catch (err) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "File not found or not readable" }));
    }
    return;
  }

  if (reqUrl.pathname === "/data") {
    try {
      const content = fs.readFileSync(currentFilePath, "utf-8");
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.end(content);
    } catch (err) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "File not found: " + currentFilePath }));
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Codex Renderer running at http://localhost:${PORT}`);
  console.log(`Default file: ${currentFilePath}`);
  console.log(`Use the UI to open a different file, or press Enter in the file path input.`);
});
