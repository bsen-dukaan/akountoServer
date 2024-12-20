require("dotenv").config();
const OAuthClient = require("intuit-oauth");
const popsicle = require("popsicle");
const { uploadFileFromBuffer } = require("../../../services/storage");
const { Integration } = require("../../../db/models");
const redirectUri =
  process.env.quickbooksRedirectUri ||
  "http://localhost:4000/api/quickbooks/callback";
const oauthClient = new OAuthClient({
  clientId: process.env.quickbooksClientId,
  clientSecret: process.env.quickbooksClientSec,
  environment: "sandbox",
  redirectUri: redirectUri,
});

class quickbooksApiClient {
  constructor(config, integrationId) {
    this.realmId = config.realmId;
    this.config = config;
    this.baseUrl = `https://sandbox-quickbooks.api.intuit.com/v3/company/${config.realmId}`;
    this.integrationId = integrationId;

    // oauthClient.setToken(this.config);
  }

  // QuickBook API credentials validation
  // async validateCredentials() {
  //   try {
  //     const response = await this.get("/v3/company/info");
  //     if (response.status === 200) {
  //       return true;
  //     }
  //     throw new Error("Invalid credentials");
  //   } catch (error) {
  //     console.error("Error validating QuickBooks API credentials:", error);
  //     throw new Error("Invalid QuickBooks API credentials");
  //   }
  // }
  // async get(endpoint) {
  //   try {
  //     await this.refreshOrSetToken();
  //     const response = await oauthClient.makeApiCall({
  //       url: `${this.baseUrl}${endpoint}`,
  //       method: "GET",
  //       headers: {
  //         "Content-Type": "application/json",
  //       },
  //     });
  //     return response;
  //   } catch (error) {
  //     console.error("Error in GET request:", error);
  //     throw error;
  //   }
  // }

  async getOAuthRedirectURL(state) {
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state: state,
    });

    return authUri;
  }



  async createToken(token) {
    const res_token = await oauthClient.createToken(token);
    return res_token;
  }

  async refreshOrSetToken() {
    const isValid = oauthClient.isAccessTokenValid();

    console.log("isToeknValid ---->>>>", isValid);

    const config = this.config;
    const integrationId = this.integrationId;

    oauthClient.setToken(this.config);

    try {
      if (!isValid) {
        await oauthClient
          .refreshUsingToken(this.config.refresh_token)
          .then(async function (authResponse) {
            const refreshToken = authResponse.json;

            const credentials = {
              realmId: config.realmId,
              token_type: refreshToken.token_type,
              access_token: refreshToken.access_token,
              expires_in: refreshToken.expires_in,
              x_refresh_token_expires_in:
                refreshToken.x_refresh_token_expires_in,
              refresh_token: refreshToken.refresh_token,
              id_token: config.id_token,
              latency: config.latency,
            };

            console.log('access_credentails ---->>>', credentials)

            await Integration.update(
              {
                credentials,
              },
              {
                where: { id: integrationId },
              },
            );

            oauthClient.setToken(credentials);
          })
          .catch(function (e) {
            console.error("The error message is :" + e);
          });
      }
    } catch (error) {
      console.error("Error in refreshOrSetToken : ", error);
    }
  }

  async count(entity) {
    const query = `SELECT COUNT(*) FROM ${entity}`;

    try {
      const response = await oauthClient.makeApiCall({
        url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=70`,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      return response.body.QueryResponse.totalCount;
    } catch (error) {
      console.error(`Error fetching ${entity} count:`, error);
      throw error;
    }
  }

  invoices = {
    list: async (page = 1, pageSize = 10) => {
      try {
        const startPosition = (page - 1) * pageSize + 1;
        const endPosition = page * pageSize;
        const query = `select * from Invoice startPosition ${startPosition} maxResults ${pageSize}`;
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return {
          invoices: response.body.QueryResponse.Invoice,
          currentPage: page,
          pageSize: pageSize,
          totalCount: response.body.QueryResponse.totalCount,
        };
      } catch (error) {
        console.error("Error fetching invoices with pagination:", error);
        throw error;
      }
    },

    create: async (invoiceData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/invoice?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(invoiceData),
        });

        return response;
      } catch (error) {
        console.log("invoiceData --->>>>", JSON.stringify(invoiceData));
        console.log(
          "invoiceCreateError --->>>",
          JSON.stringify(error?.response?.data),
        );
        throw "failed to create invoice";
      }
    },

    get: async (id) => {
      try {
        await this.refreshOrSetToken();

        const query = `select * from Invoice where Id = '${id}'`;

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return response.body.QueryResponse.Invoice[0];
      } catch (error) {
        console.error("Error fetching invoice:", error);
        throw error;
      }
    },

    update: async (invoiceData) => {
      console.log("updating started...");

      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/invoice?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(invoiceData),
        });

        return response;
      } catch (error) {
        console.error("Error updating invoice:", error);
        throw error;
      }
    },
  };

  customers = {
    findByName: async (name) => {
      try {
        await this.refreshOrSetToken();
        const query = `SELECT * FROM Customer WHERE DisplayName = '${name}'`;
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (
          response.body.QueryResponse.Customer &&
          response.body.QueryResponse.Customer.length > 0
        ) {
          return response.body.QueryResponse.Customer[0];
        }
        return null;
      } catch (error) {
        console.error("Error finding customer by name:", error);
        throw error;
      }
    },

    list: async (page = 1, pageSize = 10) => {
      try {
        const startPosition = (page - 1) * pageSize + 1;
        const query = `SELECT *  FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return {
          customers: response.body.QueryResponse.Customer,
          currentPage: page,
          pageSize: pageSize,
        };
      } catch (error) {
        console.error("Error fetching customers with pagination:", error);
        throw error;
      }
    },

    create: async (customerData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/customer?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(customerData),
        });
        return response;
      } catch (error) {
        console.log(
          "customerCreateError",
          JSON.stringify(error?.response?.data),
        );
        throw "failed to create customer";
      }
    },

    getCustomer: async (id) => {
      try {
        await this.refreshOrSetToken();

        console.log("Customer fetching started...");

        const query = `select * from Customer Where Id = '${id}'`;

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return response;
      } catch (error) {
        console.error("Error fetching customer:", error);
        throw error;
      }
    },

    update: async (customerData) => {
      try {
        await this.refreshOrSetToken();

        console.log("Updating started...");

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/customer?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(customerData),
        });

        console.log("updating done: ", response);
        return response;
      } catch (error) {
        console.error("Error updating customer:", error);
        throw error;
      }
    },
  };

  company = {
    getInfo: async () => {
      try {
        const response = await fetch(
          `${this.baseUrl}/companyinfo/${this.realmId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              Accept: "application/json",
            },
          },
        );

        if (!response.ok) throw new Error("Failed to fetch company info");
        const data = await response.json();
        return data.CompanyInfo;
      } catch (error) {
        console.error("Error fetching company info:", error);
        throw error;
      }
    },
  };

  expenses = {
    list: async (pageNumber = 1, pageSize = 10) => {
      try {
        const startPosition = (pageNumber - 1) * pageSize + 1;
        const endPosition = pageNumber * pageSize;
        const query = `select * from Purchase startPosition ${startPosition} maxResults ${pageSize}`;
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return {
          expenses: response.body.QueryResponse.Purchase,
          currentPage: pageNumber,
          pageSize: pageSize,
          totalCount: response.body.QueryResponse.totalCount,
        };
      } catch (error) {
        console.error("Error fetching expenses:", error);
        throw error;
      }
    },

    create: async (expenseData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/purchase`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(expenseData),
        });

        return response.body;
      } catch (error) {
        console.log(
          "expenseCreateError",
          JSON.stringify(error?.response?.data),
        );
        throw "failed to create expense";
      }
    },

    get: async (expenseId) => {
      try {
        await this.refreshOrSetToken();

        const query = `select * from Purchase where Id = '${expenseId}'`;

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return response.body.QueryResponse.Purchase[0];
      } catch (error) {
        console.error("Error fetching expense:", error);
        throw error;
      }
    },

    update: async (expenseData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/purchase?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(expenseData),
        });

        return response.body;
      } catch (error) {
        console.error("Error updating expense:", error);
        throw error;
      }
    },

    delete: async (expenseId) => {
      try {
        const response = await fetch(`${this.baseUrl}/expense/${expenseId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        });
        if (!response.ok) throw new Error("Failed to delete expense");
        return true;
      } catch (error) {
        console.error("Error deleting expense:", error);
        throw error;
      }
    },
  };

  vendors = {
    list: async (page = 1, pageSize = 10) => {
      try {
        const startPosition = (page - 1) * pageSize + 1;
        const endPosition = page * pageSize;
        const query = `select * from Vendor startPosition ${startPosition} maxResults ${pageSize}`;
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });
        // const data = await response.json();
        return {
          vendors: response.body.QueryResponse.Vendor,
          currentPage: page,
          pageSize: pageSize,
          totalCount: response.body.QueryResponse.totalCount,
        };
      } catch (error) {
        console.error("Error fetching vendors with pagination:", error);
        throw error;
      }
    },

    create: async (vendorData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/vendor?minorversion=70`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(vendorData),
        });
        return response;
      } catch (error) {
        console.log("vendorCreateError", JSON.stringify(error?.response?.data));
        throw "failed to create vendor";
      }
    },

    getVendor: async (id) => {
      try {
        await this.refreshOrSetToken();

        const query = `select * from Vendor Where Id = '${id}'`;

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        return response.body.QueryResponse;
      } catch (error) {
        console.error("error while fetching vendor", error);
      }
    },

    update: async (vendorData) => {
      try {
        await this.refreshOrSetToken();

        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/vendor?minorversion=70`,
          method: "POST", // QuickBooks API uses POST for update operations
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(vendorData),
        });

        return response;
      } catch (error) {
        console.error("Error updating vendor:", error);
        throw error;
      }
    },

    delete: async (vendorId) => {
      try {
        const response = await fetch(
          `${this.baseUrl}/vendor/${vendorId}?operation=delete`,
          {
            method: "POST", // QuickBooks API uses POST for delete operations
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          },
        );
        if (!response.ok) throw new Error("Failed to delete vendor");
        return true;
      } catch (error) {
        console.error("Error deleting vendor:", error);
        throw error;
      }
    },
  };

  accounts = {
    list: async (page = 1, pageSize = 10) => {
      try {
        const startPosition = (page - 1) * pageSize + 1;
        const endPosition = page * pageSize;
        const query = `select * from Account startPosition ${startPosition} maxResults ${pageSize}`;
        const response = await fetch(
          `${this.baseUrl}/query?query=${encodeURIComponent(query)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              Accept: "application/json",
            },
          },
        );
        if (!response.ok) throw new Error("Failed to fetch accounts");
        const data = await response.json();
        return {
          accounts: data.QueryResponse.Account,
          currentPage: page,
          pageSize: pageSize,
          totalCount: data.QueryResponse.totalCount,
        };
      } catch (error) {
        console.error("Error fetching accounts:", error);
        throw error;
      }
    },

    create: async (accountData) => {
      try {
        await this.refreshOrSetToken();
        const response = await oauthClient.makeApiCall({
          url: `${this.baseUrl}/account`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(accountData),
        });
        return response.body;
      } catch (error) {
        console.error("Error creating account:", error);
        throw error;
      }
    },

    update: async (accountId, accountData) => {
      try {
        const response = await fetch(`${this.baseUrl}/account/${accountId}`, {
          method: "POST", // QuickBooks API uses POST for update operations
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(accountData),
        });
        if (!response.ok) throw new Error("Failed to update account");
        const data = await response.json();
        return data;
      } catch (error) {
        console.error("Error updating account:", error);
        throw error;
      }
    },

    delete: async (accountId) => {
      try {
        const response = await fetch(
          `${this.baseUrl}/account/${accountId}?operation=delete`,
          {
            method: "POST", // QuickBooks API uses POST for delete operations
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          },
        );
        if (!response.ok) throw new Error("Failed to delete account");
        return true;
      } catch (error) {
        console.error("Error deleting account:", error);
        throw error;
      }
    },
  };
}

module.exports = quickbooksApiClient;