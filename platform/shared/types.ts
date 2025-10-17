export type ErrorExtended = {
  message: string;
  request?: {
    method: string;
    url: string;
  };
  data?: object;
  stack?: string;
};
