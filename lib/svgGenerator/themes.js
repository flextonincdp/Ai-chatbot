const { getPalette } = require('./palettes');

const themes = {
  professional: {
    defaultPalette: 'blue',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    titleFontSize: '24px',
    nodeFontSize: '14px',
    nodeCornerRadius: 6,
    edgeStrokeWidth: 2
  },
  corporate: {
    defaultPalette: 'navy',
    fontFamily: "Arial, sans-serif",
    titleFontSize: '26px',
    nodeFontSize: '15px',
    nodeCornerRadius: 4,
    edgeStrokeWidth: 2
  },
  executive: {
    defaultPalette: 'navy',
    fontFamily: "'Georgia', serif",
    titleFontSize: '28px',
    nodeFontSize: '14px',
    nodeCornerRadius: 2,
    edgeStrokeWidth: 1.5
  },
  technology: {
    defaultPalette: 'blue_teal',
    fontFamily: "'SF Mono', 'Roboto Mono', monospace",
    titleFontSize: '22px',
    nodeFontSize: '13px',
    nodeCornerRadius: 8,
    edgeStrokeWidth: 2
  },
  finance: {
    defaultPalette: 'green',
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    titleFontSize: '24px',
    nodeFontSize: '14px',
    nodeCornerRadius: 0,
    edgeStrokeWidth: 2
  },
  healthcare: {
    defaultPalette: 'blue',
    fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    titleFontSize: '24px',
    nodeFontSize: '14px',
    nodeCornerRadius: 10,
    edgeStrokeWidth: 2.5
  },
  education: {
    defaultPalette: 'orange',
    fontFamily: "'Comic Sans MS', 'Chalkboard SE', sans-serif", // Or something more appropriate, maybe just rounded sans
    titleFontSize: '26px',
    nodeFontSize: '16px',
    nodeCornerRadius: 12,
    edgeStrokeWidth: 3
  },
  minimal: {
    defaultPalette: 'monochrome',
    fontFamily: "Helvetica, Arial, sans-serif",
    titleFontSize: '20px',
    nodeFontSize: '12px',
    nodeCornerRadius: 0,
    edgeStrokeWidth: 1
  },
  modern: {
    defaultPalette: 'purple',
    fontFamily: "'Inter', sans-serif",
    titleFontSize: '28px',
    nodeFontSize: '15px',
    nodeCornerRadius: 16,
    edgeStrokeWidth: 2.5
  }
};

// Fix education font to be more professional but rounded
themes.education.fontFamily = "'Nunito', 'Quicksand', sans-serif";

// Alias: "technical" maps to "technology"
themes.technical = themes.technology;

function resolveTheme(themeName, paletteName = 'auto', customBranding = null) {
  const theme = themes[themeName] || themes['professional'];
  
  let selectedPaletteName = paletteName;
  if (!selectedPaletteName || selectedPaletteName === 'auto' || selectedPaletteName === 'custom') {
    selectedPaletteName = theme.defaultPalette;
  }
  
  let paletteOverrides = null;
  if (customBranding && customBranding.useClientBranding) {
      paletteOverrides = {
          primary: customBranding.primaryColor,
          secondary: customBranding.secondaryColor,
          accent: customBranding.accentColor,
          background: customBranding.backgroundColor,
          text: customBranding.textColor
      };
      // Clean undefined values
      Object.keys(paletteOverrides).forEach(key => {
          if (paletteOverrides[key] === undefined) {
              delete paletteOverrides[key];
          }
      });
  }

  const palette = getPalette(selectedPaletteName, paletteOverrides);
  
  return {
    ...theme,
    palette
  };
}

module.exports = { themes, resolveTheme };
