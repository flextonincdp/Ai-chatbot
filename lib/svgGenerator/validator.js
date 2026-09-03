const ALLOWED_TEMPLATES = [
  'organization_chart',
  'process_flow',
  'workflow',
  'timeline',
  'architecture',
  'hierarchy',
  'comparison',
  'decision_tree',
  'roadmap',
  'mind_map'
];

const ALLOWED_THEMES = [
  'professional',
  'corporate',
  'executive',
  'technology',
  'finance',
  'healthcare',
  'education',
  'minimal',
  'modern'
];

const ALLOWED_PALETTES = [
  'blue',
  'blue_teal',
  'navy',
  'green',
  'purple',
  'orange',
  'monochrome',
  'custom',
  'auto'
];

/**
 * Validates the JSON configuration returned by the LLM.
 * Applies safe defaults for any invalid fields.
 */
function validateSvgConfig(config) {
  if (!config || typeof config !== 'object') {
    return {
      template: 'process_flow',
      theme: 'professional',
      palette: 'blue',
      title: 'Diagram',
      data: { nodes: [], edges: [] }
    };
  }

  const validated = { ...config };

  if (!ALLOWED_TEMPLATES.includes(validated.template)) {
    validated.template = 'process_flow';
  }

  if (!ALLOWED_THEMES.includes(validated.theme)) {
    validated.theme = 'professional';
  }

  if (!ALLOWED_PALETTES.includes(validated.palette)) {
    validated.palette = 'blue';
  }

  if (!validated.title) {
    validated.title = 'Generated Diagram';
  }

  if (!validated.data) {
    validated.data = { nodes: [], edges: [] };
  }

  // Ensure nodes and edges are arrays
  if (!Array.isArray(validated.data.nodes)) {
    validated.data.nodes = [];
  }
  if (!Array.isArray(validated.data.edges)) {
    validated.data.edges = [];
  }

  // Basic sanitization of strings to prevent SVG injection in titles/labels
  const sanitizeStr = (str, maxLength = 160) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  };

  validated.title = sanitizeStr(validated.title, 120) || 'Generated Diagram';

  // Keep only the approved schema fields. The renderer never receives model
  // supplied SVG/HTML or arbitrary metadata.
  const seenNodeIds = new Set();
  validated.data.nodes = validated.data.nodes
    .slice(0, 50)
    .map((node, index) => {
      const id = sanitizeStr(node && node.id, 64).replace(/[^A-Za-z0-9_-]/g, '_') || `node_${index + 1}`;
      return {
        id,
        label: sanitizeStr(node && node.label, 120) || id,
        role: sanitizeStr(node && node.role, 120),
        description: sanitizeStr(node && node.description, 240)
      };
    })
    .filter(node => {
      if (seenNodeIds.has(node.id)) return false;
      seenNodeIds.add(node.id);
      return true;
    });

  const validNodeIds = new Set(validated.data.nodes.map(node => node.id));
  validated.data.edges = validated.data.edges
    .slice(0, 100)
    .map(edge => ({
      source: sanitizeStr(edge && edge.source, 64).replace(/[^A-Za-z0-9_-]/g, '_'),
      target: sanitizeStr(edge && edge.target, 64).replace(/[^A-Za-z0-9_-]/g, '_'),
      label: sanitizeStr(edge && edge.label, 120)
    }))
    .filter(edge => edge.source && edge.target && edge.source !== edge.target && validNodeIds.has(edge.source) && validNodeIds.has(edge.target));

  return validated;
}

module.exports = {
  ALLOWED_TEMPLATES,
  ALLOWED_THEMES,
  ALLOWED_PALETTES,
  validateSvgConfig
};
