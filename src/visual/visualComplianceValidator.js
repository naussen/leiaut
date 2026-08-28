const fs = require('fs');
const path = require('path');
const { normalizeKey } = require('./visualManifestReader');

function countMarkdownTables(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    let count = 0;
    for (let index = 0; index < lines.length - 1; index += 1) {
        if (/^\s*\|?.+\|.+\|?\s*$/.test(lines[index])
            && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
            count += 1;
            index += 1;
        }
    }
    return count;
}

function countMarkdownHighlights(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    let count = 0;
    for (let index = 0; index < lines.length; index += 1) {
        if (/^\s*>/.test(lines[index])) {
            const blockStart = index;
            while (index + 1 < lines.length && (/^\s*>/.test(lines[index + 1]) || !lines[index + 1].trim())) index += 1;
            const block = lines.slice(blockStart, index + 1);
            if (!/^\s*>\s*(?:\*{1,2})?Flashcard\s+\d+/im.test(block.join('\n'))) count += 1;
        } else if (/^\s*:::\s*\w+/i.test(lines[index])) {
            count += 1;
        }
    }
    return count + (String(markdown).match(/<mark\b[^>]*>[^<]+<\/mark>/gi) || []).length;
}

function observeMarkdownResources(markdown) {
    return {
        table: countMarkdownTables(markdown),
        mermaid: (String(markdown).match(/```mermaid[ \t]*(?:\r?\n|$)/gi) || []).length,
        highlight: countMarkdownHighlights(markdown),
        mnemonic: (String(markdown).match(/\bmnem[oô]nic[oa]?(?:\b|\s*:)/gi) || []).length > 0 ? 1 : 0,
    };
}

function observeJsonResources(data) {
    const observed = { table: 0, mermaid: 0, highlight: 0, mnemonic: 0 };
    (data.sections || []).forEach(section => {
        observed.table += countMarkdownTables(section.content_markdown);
        if (typeof section.mermaid_mindmap === 'string' && section.mermaid_mindmap.trim()) observed.mermaid += 1;
        observed.highlight += Array.isArray(section.callouts) ? section.callouts.length : 0;
        observed.mnemonic += Array.isArray(section.mnemonics) ? section.mnemonics.length : 0;
    });
    return observed;
}

function validateVisualManifestOutput(data, markdown, context) {
    const topics = context?.topics || [];
    if (topics.length === 0) {
        return { valid: true, issues: [], markdown: observeMarkdownResources(markdown), json: observeJsonResources(data) };
    }
    const markdownObserved = observeMarkdownResources(markdown);
    const jsonObserved = observeJsonResources(data);
    const issues = [];
    topics.forEach(topic => topic.requirements.forEach(requirement => {
        const observed = jsonObserved[requirement.resource] || 0;
        if (observed < requirement.minimum) {
            issues.push({ code: 'VISUAL_RESOURCE_MISSING', topic_slug: topic.topic_slug, section: requirement.target_section || null, resource: requirement.resource, expected: requirement.minimum, observed });
        }
        if (observed > requirement.maximum) {
            issues.push({ code: 'VISUAL_RESOURCE_EXCESS', topic_slug: topic.topic_slug, section: requirement.target_section || null, resource: requirement.resource, expected: requirement.maximum, observed });
        }
        if (markdownObserved[requirement.resource] > jsonObserved[requirement.resource]) {
            issues.push({ code: 'VISUAL_RESOURCE_LOST_IN_JSON', topic_slug: topic.topic_slug, section: requirement.target_section || null, resource: requirement.resource, markdown: markdownObserved[requirement.resource], json: jsonObserved[requirement.resource], expected: requirement.minimum, observed: jsonObserved[requirement.resource] });
        }
    }));
    return { valid: issues.length === 0, issues, markdown: markdownObserved, json: jsonObserved };
}

function assertVisualManifestOutput(data, markdown, context) {
    const result = validateVisualManifestOutput(data, markdown, context);
    if (!result.valid) {
        const error = new Error(
            `Divergência visual obrigatória: ${result.issues.map(issue => (
                `${issue.topic_slug}/${issue.resource} esperado=${issue.expected} observado=${issue.observed}`
            )).join('; ')}`
        );
        error.code = 'LEIAUT_VISUAL_COMPLIANCE_INVALID';
        error.details = result;
        throw error;
    }
    return result;
}

function writeVisualValidationReport(outputPath, context, result) {
    if (!context) return null;
    const reportPath = `${outputPath.replace(/\.json$/i, '')}.visual-validation.json`;
    const report = {
        schema_version: 1,
        valid: result.valid,
        manifest_path: path.basename(context.manifestPath),
        manifest_sha256: context.manifestHash,
        topics: context.topics.map(topic => topic.topic_slug),
        markdown_resources: result.markdown,
        json_resources: result.json,
        issues: result.issues,
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const temporaryPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, reportPath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    return reportPath;
}

module.exports = {
    countMarkdownTables,
    countMarkdownHighlights,
    observeMarkdownResources,
    observeJsonResources,
    validateVisualManifestOutput,
    assertVisualManifestOutput,
    writeVisualValidationReport,
};
