import { LLMClient } from "../llm/LLMClient.js";
import { buildCompressionPrompt } from "./prompts.js";
import type { PersistedMessage } from "../types.js";
import { logger } from "../../utils/logger.js";

export interface CompressionResult {
  success: boolean;
  compressedContent?: string;
  originalSize: number;
  compressedSize?: number;
  error?: string;
}

export class ContextCompressor {
  private llmClient: LLMClient;
  private targetRatio: number;

  constructor(llmClient: LLMClient, targetRatio: number = 0.3) {
    this.llmClient = llmClient;
    this.targetRatio = targetRatio;
  }

  async compress(messages: PersistedMessage[]): Promise<CompressionResult> {
    const messagesToCompress = messages.filter((m) => m.role !== "system");

    if (messagesToCompress.length === 0) {
      return {
        success: false,
        originalSize: 0,
        error: "No messages to compress"
      };
    }

    const originalSize = messagesToCompress.reduce((sum, m) => sum + m.content.length, 0);
    const targetSize = Math.floor(originalSize * this.targetRatio);

    const formattedMessages = messagesToCompress.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp
    }));

    const prompt = buildCompressionPrompt(formattedMessages);

    try {
      const response = await this.llmClient.generate([{ role: "user", content: prompt }]);

      const compressedContent = response.content;
      const compressedSize = compressedContent.length;

      if (compressedSize > originalSize * 0.5) {
        logger.warn(
          `Compression warning: result size ${compressedSize} is larger than 50% of original ${originalSize}`
        );
      }

      return {
        success: true,
        compressedContent,
        originalSize,
        compressedSize
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        originalSize,
        error: `Compression failed: ${errorMessage}`
      };
    }
  }

  async compressIfNeeded(messages: PersistedMessage[], threshold: number): Promise<CompressionResult> {
    const messagesToCompress = messages.filter((m) => m.role !== "system");
    const currentSize = messagesToCompress.reduce((sum, m) => sum + m.content.length, 0);

    if (currentSize < threshold) {
      return {
        success: true,
        compressedContent: undefined,
        originalSize: currentSize,
        compressedSize: currentSize
      };
    }

    return this.compress(messages);
  }
}

export function createContextCompressor(llmClient: LLMClient, targetRatio?: number): ContextCompressor {
  return new ContextCompressor(llmClient, targetRatio);
}
