// lib/titleGenerator.js

/**
 * Normalizes a string for comparison.
 */
function normalizeForComparison(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Generates a professional title based on intent, style, and topic.
 */
function generateProfessionalTitle(topic, intentJson, query) {
  const qLower = String(query || '').toLowerCase();
  
  // 1. Detect Style
  let style = '';
  if (qLower.includes('professional')) style = 'Professional ';
  else if (qLower.includes('detailed') || qLower.includes('more detail') || qLower.includes('more content') || qLower.includes('large content') || qLower.includes('explain more') || qLower.includes('explain in detail')) style = 'Detailed ';
  else if (qLower.includes('comprehensive')) style = 'Comprehensive ';
  else if (qLower.includes('executive')) style = 'Executive ';
  else if (qLower.includes('brief') || qLower.includes('short')) style = 'Brief ';
  
  // 2. Detect Operation/Intent from query or intentJson
  let operation = 'Overview';
  const intentStr = String(intentJson?.intent || 'ANSWER').toUpperCase();
  
  if (qLower.includes('summary') || qLower.includes('summarize') || qLower.includes('summarise') || intentStr === 'SUMMARY') {
    operation = 'Summary';
  } else if (qLower.includes('bullet') || qLower.includes('points') || qLower.includes('key point')) {
    operation = 'Key Points:';
    style = ''; // Usually "Key Points: Topic" looks better without style prefix
  } else if (qLower.includes('analysis') || qLower.includes('analyze')) {
    operation = 'Analysis';
  } else if (qLower.includes('explain') || qLower.includes('explanation')) {
    operation = 'Explanation';
  } else if (qLower.includes('guide') || qLower.includes('how to') || qLower.includes('steps')) {
    operation = 'Guide to';
  } else if (qLower.includes('report')) {
    operation = 'Report';
  }
  
  // 3. Resolve Topic
  let resolvedTopic = topic;
  if (!resolvedTopic || resolvedTopic === 'null' || resolvedTopic === 'undefined') {
    resolvedTopic = 'Selected Document Context';
  }
  
  // Clean up the topic (capitalize words)
  const cleanTopic = resolvedTopic.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

  // 4. Assemble
  if (operation.includes(':') || operation === 'Guide to') {
    return `${style}${operation} ${cleanTopic}`.trim();
  } else {
    return `${style}${operation} of ${cleanTopic}`.trim();
  }
}

/**
 * Validates if the generated title is too similar to the raw user query,
 * and if so, replaces it using the professional generator.
 */
function validateAndFixTitle(answerText, query, intentJson, resolvedTopic) {
  if (!answerText) return answerText;
  
  // Try to find the title in markdown or HTML
  // Match `# Title` or `<h2>Title</h2>` or `<h3>Title</h3>`
  let titleMatch = answerText.match(/^(?:#+|<h[123][^>]*>)\s*([^<\n]+)(?:<\/h[123]>|\n)/i);
  
  // If no title found at the very beginning, maybe it's just the first line
  if (!titleMatch) {
    const firstLine = answerText.trim().split('\n')[0];
    if (firstLine && firstLine.length < 100 && !firstLine.includes('>') && !firstLine.includes('<')) {
      titleMatch = [firstLine, firstLine.replace(/^[#\s]+/, '').trim()];
    }
  }

  if (titleMatch && titleMatch[1]) {
    const extractedTitle = titleMatch[1].trim();
    const normTitle = normalizeForComparison(extractedTitle);
    const normQuery = normalizeForComparison(query);
    
    // If the title is just the user query capitalized/repeated
    if (normTitle && normQuery && (normTitle === normQuery || normQuery.includes(normTitle) || normTitle.includes(normQuery))) {
      // Regenerate title
      const newTitle = generateProfessionalTitle(resolvedTopic, intentJson, query);
      
      // Replace the old title in the answer text
      const oldTitleStr = titleMatch[0];
      let newTitleStr = oldTitleStr;
      
      if (oldTitleStr.includes('<h')) {
        newTitleStr = oldTitleStr.replace(extractedTitle, newTitle);
      } else if (oldTitleStr.startsWith('#')) {
        newTitleStr = oldTitleStr.replace(extractedTitle, newTitle);
      } else {
        newTitleStr = `<h3>${newTitle}</h3>\n`;
      }
      
      console.log(`[TITLE VALIDATION] Replaced raw query title "${extractedTitle}" with "${newTitle}"`);
      return answerText.replace(oldTitleStr, newTitleStr);
    }
  }
  
  return answerText;
}

module.exports = {
  generateProfessionalTitle,
  validateAndFixTitle
};
