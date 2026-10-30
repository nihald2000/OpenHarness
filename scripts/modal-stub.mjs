export class ModalClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.apps = {
      fromName: async (name) => ({ name }),
    };
    this.images = {
      fromId: async (imageId) => ({ imageId }),
    };
    this.sandboxes = {
      create: async () => {
        throw new Error("MODAL_TOKEN_ID is required for live ModalClient.sandboxes.create");
      },
      fromId: async () => {
        throw new Error("MODAL_TOKEN_ID is required for live ModalClient.sandboxes.fromId");
      },
      list: async function* () {},
    };
  }
}
