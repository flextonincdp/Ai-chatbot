const palettes = {
  blue: {
    primary: '#1e40af',
    secondary: '#3b82f6',
    accent: '#60a5fa',
    background: '#eff6ff',
    text: '#1e3a8a',
    border: '#bfdbfe'
  },
  blue_teal: {
    primary: '#0f766e',
    secondary: '#0ea5e9',
    accent: '#38bdf8',
    background: '#f0fdfa',
    text: '#134e4a',
    border: '#bae6fd'
  },
  navy: {
    primary: '#1e3a8a',
    secondary: '#1e40af',
    accent: '#cbd5e1',
    background: '#f8fafc',
    text: '#0f172a',
    border: '#e2e8f0'
  },
  green: {
    primary: '#166534',
    secondary: '#22c55e',
    accent: '#86efac',
    background: '#f0fdf4',
    text: '#14532d',
    border: '#bbf7d0'
  },
  purple: {
    primary: '#6b21a8',
    secondary: '#a855f7',
    accent: '#d8b4fe',
    background: '#faf5ff',
    text: '#581c87',
    border: '#e9d5ff'
  },
  orange: {
    primary: '#c2410c',
    secondary: '#f97316',
    accent: '#fdba74',
    background: '#fff7ed',
    text: '#7c2d12',
    border: '#fed7aa'
  },
  monochrome: {
    primary: '#1f2937',
    secondary: '#4b5563',
    accent: '#9ca3af',
    background: '#f9fafb',
    text: '#111827',
    border: '#e5e7eb'
  },
  // ---------- Document Export Palettes ----------
  professional_blue: {
    primary: '#1e40af',
    secondary: '#3b82f6',
    accent: '#60a5fa',
    background: '#f8fafc',
    text: '#1e293b',
    border: '#bfdbfe'
  },
  navy_blue: {
    primary: '#1e3a8a',
    secondary: '#2563eb',
    accent: '#93c5fd',
    background: '#f8fafc',
    text: '#0f172a',
    border: '#e2e8f0'
  },
  corporate_gray: {
    primary: '#374151',
    secondary: '#6b7280',
    accent: '#9ca3af',
    background: '#f9fafb',
    text: '#111827',
    border: '#e5e7eb'
  },
  executive_black_gold: {
    primary: '#1c1917',
    secondary: '#b45309',
    accent: '#f59e0b',
    background: '#fefce8',
    text: '#1c1917',
    border: '#d6d3d1'
  },
  technology_blue: {
    primary: '#0284c7',
    secondary: '#06b6d4',
    accent: '#22d3ee',
    background: '#f0f9ff',
    text: '#0c4a6e',
    border: '#bae6fd'
  },
  finance_green: {
    primary: '#166534',
    secondary: '#15803d',
    accent: '#4ade80',
    background: '#f0fdf4',
    text: '#14532d',
    border: '#bbf7d0'
  },
  healthcare_blue: {
    primary: '#0369a1',
    secondary: '#0ea5e9',
    accent: '#7dd3fc',
    background: '#f0f9ff',
    text: '#0c4a6e',
    border: '#bae6fd'
  },
  education_purple: {
    primary: '#7c3aed',
    secondary: '#8b5cf6',
    accent: '#c4b5fd',
    background: '#faf5ff',
    text: '#4c1d95',
    border: '#ddd6fe'
  },
  minimal_monochrome: {
    primary: '#1f2937',
    secondary: '#4b5563',
    accent: '#9ca3af',
    background: '#ffffff',
    text: '#111827',
    border: '#e5e7eb'
  }
};

function getPalette(name, customOverrides = null) {
  const base = palettes[name] || palettes['blue'];
  if (customOverrides) {
    return { ...base, ...customOverrides };
  }
  return base;
}

module.exports = { palettes, getPalette };
