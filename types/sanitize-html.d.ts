declare module "sanitize-html" {
  type TransformTags = Record<string, (tagName: string, attribs: Record<string, string>) => any>;

  type SanitizeOptions = {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedSchemes?: string[];
    transformTags?: TransformTags;
  };

  interface SanitizeHtmlFn {
    (html: string, options?: SanitizeOptions): string;
    simpleTransform: (tagName: string, attribs?: Record<string, string>, merge?: boolean) => any;
  }

  const sanitizeHtml: SanitizeHtmlFn;
  export default sanitizeHtml;
}
