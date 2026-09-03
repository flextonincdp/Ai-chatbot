const { wrapText, multilineText, parseFontSize } = require('../text');

/**
 * Renders an Organization Chart SVG.
 * Expects config.data.nodes and config.data.edges.
 */
function render(config, theme) {
  const { title, data } = config;
  const { nodes, edges } = data;
  const { palette, fontFamily, titleFontSize, nodeFontSize, nodeCornerRadius, edgeStrokeWidth } = theme;

  // Extremely naive layout for an org chart (a real implementation might use dagre or similar)
  // For this prototype, we'll assign positions based on a simple breadth-first traversal if edges exist,
  // or just a grid if they don't.
  
  const nodeWidth = 190;
  const nodeFontPx = parseFontSize(nodeFontSize, 14);
  const nodeLineHeight = Math.ceil(nodeFontPx * 1.25);
  const roleFontPx = 11;
  const roleLineHeight = 13;
  const labelMaxChars = Math.max(17, Math.floor((nodeWidth - 28) / (nodeFontPx * 0.58)));
  const roleMaxChars = Math.max(20, Math.floor((nodeWidth - 28) / (roleFontPx * 0.58)));
  const siblingSpacing = nodeWidth + 45;

  // SVG text has no built-in wrapping. Calculate each card height from the
  // text it will contain, then give each tree level enough breathing room.
  const nodeMetrics = new Map(nodes.map(node => {
    const titleLines = wrapText(node.label || node.id, labelMaxChars);
    const roleLines = node.role ? wrapText(node.role, roleMaxChars, 2) : [];
    const height = Math.max(64, titleLines.length * nodeLineHeight + (roleLines.length ? roleLines.length * roleLineHeight + 8 : 0) + 24);
    return [node.id, { titleLines, roleLines, height }];
  }));
  const maxNodeHeight = Math.max(64, ...[...nodeMetrics.values()].map(metric => metric.height));
  const levelHeight = maxNodeHeight + 70;
  const titleOffset = 105;

  // Identify root nodes (nodes with no incoming edges)
  const incoming = new Set(edges.map(e => e.target));
  let roots = nodes.filter(n => !incoming.has(n.id));
  if (roots.length === 0 && nodes.length > 0) roots = [nodes[0]]; // fallback

  const levels = [];
  const visited = new Set();
  
  let currentLevel = [...roots];
  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel = [];
    for (const node of currentLevel) {
      visited.add(node.id);
      const children = edges.filter(e => e.source === node.id).map(e => nodes.find(n => n.id === e.target)).filter(Boolean);
      for (const child of children) {
        if (!visited.has(child.id) && !nextLevel.find(n => n.id === child.id)) {
          nextLevel.push(child);
        }
      }
    }
    currentLevel = nextLevel;
  }

  // Handle disconnected nodes
  const disconnected = nodes.filter(n => !visited.has(n.id));
  if (disconnected.length > 0) {
    levels.push(disconnected);
  }

  // Assign coordinates
  const positions = {};
  let maxW = 0;
  
  levels.forEach((levelNodes, depth) => {
    const totalWidth = (levelNodes.length - 1) * siblingSpacing;
    let startX = -totalWidth / 2;
    levelNodes.forEach((node, i) => {
      positions[node.id] = {
        x: startX + (i * siblingSpacing),
        y: depth * levelHeight + titleOffset, // offset for title
        height: nodeMetrics.get(node.id).height
      };
      if (Math.abs(positions[node.id].x) + nodeWidth > maxW) {
        maxW = Math.abs(positions[node.id].x) + nodeWidth;
      }
    });
  });

  const width = Math.max(800, maxW * 2 + 100);
  const height = Math.max(400, levels.length * levelHeight + 200);
  const offsetX = width / 2;

  let svgEdges = '';
  for (const edge of edges) {
    const sourcePos = positions[edge.source];
    const targetPos = positions[edge.target];
    if (sourcePos && targetPos) {
      // Orthogonal routing
      const startX = sourcePos.x + offsetX;
      const startY = sourcePos.y + sourcePos.height;
      const endX = targetPos.x + offsetX;
      const endY = targetPos.y;
      const midY = startY + (endY - startY) / 2;

      svgEdges += `
        <path d="M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}" 
              fill="none" stroke="${palette.border}" stroke-width="${edgeStrokeWidth}" />
      `;
    }
  }

  let svgNodes = '';
  for (const node of nodes) {
    const pos = positions[node.id];
    if (pos) {
      const cx = pos.x + offsetX;
      const cy = pos.y;
      
      const nodeTitle = node.label || node.id;
      const nodeRole = node.role || '';
      const metric = nodeMetrics.get(node.id);

      svgNodes += `
        <g transform="translate(${cx - nodeWidth/2}, ${cy})">
          <rect width="${nodeWidth}" height="${metric.height}" rx="${nodeCornerRadius}" fill="${palette.primary}" stroke="${palette.border}" stroke-width="1" />
          ${multilineText({ text: nodeTitle, x: nodeWidth / 2, centerY: metric.height / 2 - (metric.roleLines.length ? (metric.roleLines.length * roleLineHeight + 8) / 2 : 0), fill: palette.background, fontSize: nodeFontPx, fontWeight: 'bold', maxChars: labelMaxChars, lineHeight: nodeLineHeight })}
          ${nodeRole ? multilineText({ text: nodeRole, x: nodeWidth / 2, centerY: metric.height - (metric.roleLines.length * roleLineHeight + 12) / 2, fill: palette.accent, fontSize: roleFontPx, maxChars: roleMaxChars, maxLines: 2, lineHeight: roleLineHeight }) : ''}
        </g>
      `;
    }
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="background-color: ${palette.background};">
      <defs>
        <style>
          text { font-family: ${fontFamily}; }
        </style>
      </defs>
      ${multilineText({ text: title, x: width / 2, centerY: 40, fill: palette.text, fontSize: parseFontSize(titleFontSize, 24), fontWeight: 'bold', maxChars: Math.max(30, Math.floor(width / 15)), maxLines: 2 })}
      <g class="edges">
        ${svgEdges}
      </g>
      <g class="nodes">
        ${svgNodes}
      </g>
    </svg>
  `;

  return svg.trim();
}

module.exports = { render };
