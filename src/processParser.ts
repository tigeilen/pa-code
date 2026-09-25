export interface ProcessCode {
    Prolog: string;
    Metadata: string;
    Data: string;
    Epilog: string;
    PropertiesJSON: string; // NEU
}

export interface SectionOffset {
    /** 0-based line index of the #SECTION header in the file */
    headerLine: number;
    /** 0-based line index of the first code line (headerLine + 1) */
    codeStartLine: number;
    /** Number of code lines in this section */
    lineCount: number;
}

export interface SectionOffsets {
    Prolog?: SectionOffset;
    Metadata?: SectionOffset;
    Data?: SectionOffset;
    Epilog?: SectionOffset;
}

export class ProcessParser {
    
    static parseFileContent(content: string): ProcessCode {
        const code: ProcessCode = {
            Prolog: '',
            Metadata: '',
            Data: '',
            Epilog: '',
            PropertiesJSON: '{}' // Default
        };

        // Regex für die Code-Sektionen
        const sectionRegex = /#SECTION\s+(Prolog|Metadata|Data|Epilog)([\s\S]*?)(?=(#SECTION|#JSON_PROPERTIES|$))/gi;
        
        let match;
        while ((match = sectionRegex.exec(content)) !== null) {
            const sectionName = match[1].toLowerCase(); 
            const sectionContent = match[2].trim(); 

            if (sectionName === 'prolog') code.Prolog = sectionContent;
            else if (sectionName === 'metadata') code.Metadata = sectionContent;
            else if (sectionName === 'data') code.Data = sectionContent;
            else if (sectionName === 'epilog') code.Epilog = sectionContent;
        }

        // Regex für den JSON Block am Ende
        const jsonRegex = /#JSON_PROPERTIES([\s\S]*?)$/i;
        const jsonMatch = jsonRegex.exec(content);
        if (jsonMatch) {
            code.PropertiesJSON = jsonMatch[1].trim();
        }

        return code;
    }

    /**
     * Parse a .ti file's content and return the line offsets for each section.
     * Used for mapping between VS Code file line numbers and TM1 section-relative line numbers.
     */
    static getSectionOffsets(content: string): SectionOffsets {
        const lines = content.split(/\r?\n/);
        const offsets: SectionOffsets = {};
        const sectionNames: (keyof SectionOffsets)[] = ['Prolog', 'Metadata', 'Data', 'Epilog'];

        // Find all section header lines
        const sectionHeaders: { name: keyof SectionOffsets; lineIndex: number }[] = [];
        let jsonPropertiesLine = lines.length;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            const sectionMatch = trimmed.match(/^#SECTION\s+(Prolog|Metadata|Data|Epilog)/i);
            if (sectionMatch) {
                const name = sectionMatch[1].charAt(0).toUpperCase() + sectionMatch[1].slice(1).toLowerCase();
                sectionHeaders.push({ name: name as keyof SectionOffsets, lineIndex: i });
            } else if (/^#JSON_PROPERTIES/i.test(trimmed)) {
                jsonPropertiesLine = i;
            }
        }

        // Calculate offsets for each section
        for (let i = 0; i < sectionHeaders.length; i++) {
            const header = sectionHeaders[i];
            const nextBoundary = i + 1 < sectionHeaders.length
                ? sectionHeaders[i + 1].lineIndex
                : jsonPropertiesLine;

            // Skip leading blank lines to find actual code start
            let codeStartLine = header.lineIndex + 1;
            while (codeStartLine < nextBoundary && lines[codeStartLine].trim() === '') {
                codeStartLine++;
            }
            // If entire section is blank, reset to right after header
            if (codeStartLine >= nextBoundary) codeStartLine = header.lineIndex + 1;
            const lineCount = Math.max(0, nextBoundary - codeStartLine);

            offsets[header.name] = {
                headerLine: header.lineIndex,
                codeStartLine,
                lineCount
            };
        }

        return offsets;
    }

    /**
     * Convert a VS Code 0-based file line number to a TM1 section + 1-based line number.
     * Returns null if the line is not inside any code section.
     */
    static fileLineToTM1Line(fileLine: number, offsets: SectionOffsets): { section: string; tm1Line: number } | null {
        for (const sectionName of ['Prolog', 'Metadata', 'Data', 'Epilog'] as (keyof SectionOffsets)[]) {
            const offset = offsets[sectionName];
            if (!offset) continue;
            if (fileLine >= offset.codeStartLine && fileLine < offset.codeStartLine + offset.lineCount) {
                const tm1Line = fileLine - offset.codeStartLine + 1; // 1-based
                return { section: sectionName, tm1Line };
            }
        }
        return null;
    }

    /**
     * Convert a TM1 section name + 1-based line number to a VS Code 0-based file line number.
     * Returns -1 if the section is not found.
     */
    static tm1LineToFileLine(section: string, tm1Line: number, offsets: SectionOffsets): number {
        const normalized = section.charAt(0).toUpperCase() + section.slice(1).toLowerCase() as keyof SectionOffsets;
        const offset = offsets[normalized];
        if (!offset) return -1;
        return offset.codeStartLine + tm1Line - 1; // convert 1-based TM1 to 0-based file line
    }
}