/*
  Turns an `[error, data]` tuple into the response for it. The HTTP layer's whole job is to extract what
  the operations need from the request and hand the result back through here.
*/
export const send = (response, [error, data], success = 200) => (
  error ? response.status(error.code).json({ error: error.msg }) : response.status(success).json(data)
);
