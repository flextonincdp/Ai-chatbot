const { wrapText, multilineText, parseFontSize } = require('../text');

/**
 * Renders a Process Flow SVG.
 * Expects config.data.nodes and config.data.edges.
 */
function render(config, theme) {
  const { title, data } = config;
  const { nodes, edges } = data;
  const { palette, fontFamily, titleFontSize, nodeFontSize, nodeCornerRadius, edgeStrokeWidth } = theme;

  const nodeWidth = 180;
  const nodeFontPx = parseFontSize(nodeFontSize, 14);
  const nodeLineHeight = Math.ceil(nodeFontPx * 1.25);
  const labelMaxChars = Math.max(16, Math.floor((nodeWidth - 28) / (nodeFontPx * 0.58)));
  const spacingX = nodeWidth + 80;
  const nodeGapY = 36;

  // Measure the labels before layout so every box has enough vertical room.
  const nodeMetrics = new Map(nodes.map(node => {
    const lines = wrapText(node.label || node.id, labelMaxChars);
    return [node.id, { lines, height: Math.max(58, lines.length * nodeLineHeight + 22) }];
  }));

  // Extremely naive layout: try to arrange left to right
  const incoming = new Set(edges.map(e => e.target));
  let roots = nodes.filter(n => !incoming.has(n.id));
  if (roots.length === 0 && nodes.length > 0) roots = [nodes[0]];

  const columns = [];
  const visited = new Set();
  
  let currentCol = [...roots];
  while (currentCol.length > 0) {
    columns.push(currentCol);
    const nextCol = [];
    for (const node of currentCol) {
      visited.add(node.id);
      const children = edges.filter(e => e.source === node.id).map(e => nodes.find(n => n.id === e.target)).filter(Boolean);
      for (const child of children) {
        if (!visited.has(child.id) && !nextCol.find(n => n.id === child.id)) {
          nextCol.push(child);
        }
      }
    }
    currentCol = nextCol;
  }

  const disconnected = nodes.filter(n => !visited.has(n.id));
  if (disconnected.length > 0) {
    columns.push(disconnected);
  }

  const positions = {};
  let maxH = 0;

  columns.forEach((colNodes, xIdx) => {
    const totalHeight = colNodes.reduce((sum, node) => sum + nodeMetrics.get(node.id).height, 0)
      + Math.max(0, colNodes.length - 1) * nodeGapY;
    let cursorY = -totalHeight / 2;
    colNodes.forEach(node => {
      const metric = nodeMetrics.get(node.id);
      positions[node.id] = {
        x: xIdx * spacingX + 50, // 50 padding left
        y: cursorY,
        height: metric.height
      };
      cursorY += metric.height + nodeGapY;
      maxH = Math.max(maxH, Math.abs(positions[node.id].y), Math.abs(positions[node.id].y + metric.height));
    });
  });

  const width = Math.max(800, columns.length * spacingX + 100);
  const height = Math.max(400, maxH + 170);
  const offsetY = (height - maxH) / 2 + 40;

  // Defs for arrowhead
  const defs = `
    <defs>
      <style>text { font-family: ${fontFamily}; }</style>
      <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="${palette.border}" />
      </marker>
    </defs>
  `;

  let svgEdges = '';
  for (const edge of edges) {
    const sourcePos = positions[edge.source];
    const targetPos = positions[edge.target];
    if (sourcePos && targetPos) {
      const startX = sourcePos.x + nodeWidth;
      const startY = sourcePos.y + sourcePos.height / 2 + offsetY;
      const endX = targetPos.x;
      const endY = targetPos.y + targetPos.height / 2 + offsetY;
      const midX = startX + (endX - startX) / 2;

      svgEdges += `
        <path d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" 
              fill="none" stroke="${palette.border}" stroke-width="${edgeStrokeWidth}" marker-end="url(#arrowhead)"/>
      `;
      if (edge.label) {
        const edgeLines = wrapText(edge.label, 12, 2);
        const edgeHeight = edgeLines.length * 11 + 6;
        svgEdges += `
          <rect x="${midX - 36}" y="${(startY+endY)/2 - edgeHeight / 2}" width="72" height="${edgeHeight}" rx="3" fill="${palette.background}" />
          ${multilineText({ text: edge.label, x: midX, centerY: (startY + endY) / 2, fill: palette.text, fontSize: 9, maxChars: 12, maxLines: 2, lineHeight: 11 })}
        `;
      }
    }
  }

  let svgNodes = '';
  for (const node of nodes) {
    const pos = positions[node.id];
    if (pos) {
      const cx = pos.x;
      const cy = pos.y + offsetY;
      
      const nodeTitle = node.label || node.id;
      
      // Determine shape based on step type (simplistic)
      let shape = `<rect width="${nodeWidth}" height="${pos.height}" rx="${nodeCornerRadius}" fill="${palette.primary}" stroke="${palette.border}" stroke-width="1" />`;
      if (nodeTitle.toLowerCase().includes('decision') || nodeTitle.includes('?')) {
        // Diamond-ish (using a polygon)
        shape = `<polygon points="${nodeWidth/2} 0, ${nodeWidth} ${pos.height/2}, ${nodeWidth/2} ${pos.height}, 0 ${pos.height/2}" fill="${palette.secondary}" stroke="${palette.border}" stroke-width="1" />`;
      }

      svgNodes += `
        <g transform="translate(${cx}, ${cy})">
          ${shape}
          ${multilineText({ text: nodeTitle, x: nodeWidth / 2, centerY: pos.height / 2, fill: palette.background, fontSize: nodeFontPx, fontWeight: 'bold', maxChars: labelMaxChars, lineHeight: nodeLineHeight })}
        </g>
      `;
    }
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="background-color: ${palette.background};">
      ${defs}
      ${multilineText({ text: title, x: width / 2, centerY: 28, fill: palette.text, fontSize: parseFontSize(titleFontSize, 24), fontWeight: 'bold', maxChars: Math.max(30, Math.floor(width / 15)), maxLines: 2 })}
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
