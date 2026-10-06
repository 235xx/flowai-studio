import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import {
  BatchEmbeddingResult,
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingResult,
} from '../../interfaces/embedding-provider.interface';

@Injectable()
export class XunfeiEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(XunfeiEmbeddingProvider.name);
  private readonly config: EmbeddingProviderConfig;

  readonly providerType = 'xunfei';

  constructor(config: EmbeddingProviderConfig) {
    this.config = {
      ...config,
      model: config.model || 'xunfei-embedding',
      dimensions: 2560,
      timeout: config.timeout ?? 30000,
      maxConcurrency: config.maxConcurrency ?? 3,
      maxRetries: config.maxRetries ?? 2,
      documentUrl:
        config.documentUrl || 'https://cn-huabei-1.xf-yun.com/v1/private/sa8a05c27',
      queryUrl:
        config.queryUrl || 'https://cn-huabei-1.xf-yun.com/v1/private/s50d55a16',
    };
  }

  /** 单条调用用于检索问题，对应 Embeddingq。 */
  async embed(text: string): Promise<EmbeddingResult> {
    this.assertConfigured();
    return { embedding: await this.callEndpoint(this.config.queryUrl!, text), tokenUsage: 0 };
  }

  /** 批量调用用于文档分块，对应 Embeddingp。 */
  async embedBatch(texts: string[], concurrency?: number): Promise<BatchEmbeddingResult> {
    this.assertConfigured();
    const limit = concurrency ?? this.config.maxConcurrency ?? 3;
    const results: BatchEmbeddingResult['results'] = [];
    const failedIndices: number[] = [];

    for (let offset = 0; offset < texts.length; offset += limit) {
      const batch = texts.slice(offset, offset + limit);
      const settled = await Promise.allSettled(
        batch.map((text) => this.callWithRetry(this.config.documentUrl!, text)),
      );
      settled.forEach((result, index) => {
        const globalIndex = offset + index;
        if (result.status === 'fulfilled') {
          results.push({ content: batch[index], embedding: result.value, tokenUsage: 0 });
        } else {
          failedIndices.push(globalIndex);
          results.push({ content: batch[index], embedding: [], tokenUsage: 0 });
          this.logger.warn(`Xunfei embedding failed for chunk ${globalIndex}: ${result.reason}`);
        }
      });
    }

    return { results, failedIndices, totalTokenUsage: 0 };
  }

  getDimensions(): number {
    return 2560;
  }

  getModel(): string {
    return this.config.model;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.embed('health check');
      return result.embedding.length === 2560;
    } catch {
      return false;
    }
  }

  private assertConfigured(): void {
    if (!this.config.appId || !this.config.apiKey || !this.config.apiSecret) {
      throw new Error('Xunfei Embedding credentials are not configured');
    }
  }

  private async callWithRetry(endpoint: string, text: string, attempt = 0): Promise<number[]> {
    try {
      return await this.callEndpoint(endpoint, text);
    } catch (error) {
      if (attempt >= (this.config.maxRetries ?? 2)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      return this.callWithRetry(endpoint, text, attempt + 1);
    }
  }

  private async callEndpoint(endpoint: string, text: string): Promise<number[]> {
    const signedUrl = this.createSignedUrl(endpoint);
    const encodedText = Buffer.from(
      JSON.stringify({ messages: [{ content: text, role: 'user' }] }),
      'utf8',
    ).toString('base64');
    const response = await axios.post(
      signedUrl,
      {
        header: { app_id: this.config.appId, uid: 'flowai-studio', status: 3 },
        parameter: { emb: { feature: { encoding: 'utf8' } } },
        payload: { messages: { text: encodedText } },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: this.config.timeout },
    );

    const code = response.data?.header?.code;
    if (code !== 0) {
      const message = response.data?.header?.message || 'unknown error';
      throw new Error(`Xunfei Embedding API error ${code}: ${message}`);
    }
    const encodedVector = response.data?.payload?.feature?.text;
    if (!encodedVector) throw new Error('Xunfei Embedding API returned no vector');

    const bytes = Buffer.from(encodedVector, 'base64');
    if (bytes.length % 4 !== 0) throw new Error('Invalid Xunfei vector byte length');
    const vector = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
    if (vector.length !== 2560) {
      throw new Error(`Unexpected Xunfei vector dimension: ${vector.length}`);
    }
    return vector;
  }

  private createSignedUrl(endpoint: string): string {
    const url = new URL(endpoint);
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${url.host}\ndate: ${date}\nPOST ${url.pathname} HTTP/1.1`;
    const signature = createHmac('sha256', this.config.apiSecret!)
      .update(signatureOrigin)
      .digest('base64');
    const authorizationOrigin =
      `api_key="${this.config.apiKey}", algorithm="hmac-sha256", ` +
      `headers="host date request-line", signature="${signature}"`;
    url.searchParams.set('authorization', Buffer.from(authorizationOrigin).toString('base64'));
    url.searchParams.set('date', date);
    url.searchParams.set('host', url.host);
    return url.toString();
  }
}
