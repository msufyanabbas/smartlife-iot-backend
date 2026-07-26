// Ambient type declaration for the `coap` npm package.
// `@types/coap` does not exist on npm (verified: registry returns 404), and the
// `coap` package ships no bundled types. This minimal declaration is enough for
// the CoAPAdapter — the library's request/response objects are used loosely, so
// we type them as `any` rather than modelling the full protocol surface.
declare module 'coap' {
  import { EventEmitter } from 'events';

  export interface CoapServerOptions {
    type?: 'udp4' | 'udp6';
    proxy?: boolean;
    [key: string]: any;
  }

  export interface CoapServer extends EventEmitter {
    listen(port: number, callback?: () => void): CoapServer;
    listen(port: number, address: string, callback?: () => void): CoapServer;
    close(callback?: () => void): CoapServer;
  }

  export function createServer(
    options?: CoapServerOptions,
    listener?: (req: any, res: any) => void,
  ): CoapServer;

  export function request(options: any): any;

  const coap: {
    createServer: typeof createServer;
    request: typeof request;
    [key: string]: any;
  };
  export default coap;
}
