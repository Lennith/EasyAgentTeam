import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { SkillConfig } from '../types.js';

export interface SkillListFile {
  skills: SkillConfig[];
}

export class SkillLoader {
  private skillListPath: string | null = null;
  private skills: SkillConfig[] = [];

  loadSkillList(filePath: string): SkillConfig[] {
    this.skillListPath = path.resolve(filePath);
    
    if (!fs.existsSync(this.skillListPath)) {
      this.skills = [];
      return this.skills;
    }

    const content = fs.readFileSync(this.skillListPath, 'utf-8');
    const parsed = yaml.load(content) as SkillListFile;
    
    if (!parsed || !parsed.skills || !Array.isArray(parsed.skills)) {
      this.skills = [];
      return this.skills;
    }

    this.skills = parsed.skills.filter(skill => skill.enabled !== false);
    return this.skills;
  }

  getSkills(): SkillConfig[] {
    return [...this.skills];
  }

  generateSkillPrompt(): string {
    if (this.skills.length === 0) {
      return '';
    }

    const skillLines = this.skills.map(skill => {
      return `- **${skill.name}**: ${skill.description}\n  Path: ${skill.path}`;
    });

    return `## Available Skills

${skillLines.join('\n\n')}

Read the SKILL.md file for detailed instructions when needed.`;
  }
}

export function createSkillLoader(): SkillLoader {
  return new SkillLoader();
}
