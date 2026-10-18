// Shared types + defaults for the destination form. NOT marked
// "use client" so that server components (e.g. the create page) can
// import the factory without crossing the client/server boundary.

export interface DestinationFormInitial {
  name: string;
  base_url: string;
  list_path: string;
  post_path: string;
  auth_header_name: string;
  auth_header_format: string;
  secret_ref: string;
  item_url_template: string;
}

export function emptyDestinationFormInitial(): DestinationFormInitial {
  return {
    name: "",
    base_url: "",
    list_path: "",
    post_path: "",
    auth_header_name: "X-API-Key",
    auth_header_format: "{secret}",
    secret_ref: "",
    item_url_template: "",
  };
}
