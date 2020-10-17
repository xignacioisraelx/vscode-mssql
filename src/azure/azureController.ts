import vscode = require('vscode');
import { AzureStringLookup } from '../azure/azureStringLookup';
import { AzureUserInteraction } from '../azure/azureUserInteraction';
import { AzureErrorLookup } from '../azure/azureErrorLookup';
import { AzureMessageDisplayer } from './azureMessageDisplayer';
import { AzureLogger } from '../azure/azureLogger';
import { AzureAuthRequest } from './azureAuthRequest';
import { SimpleTokenCache } from './cacheService';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { CredentialStore } from '../credentialstore/credentialstore';
import { StorageService } from './StorageService';
import * as utils from '../models/utils';
import { IAccount } from '../models/contracts/azure/accountInterfaces';
import { AzureAuthType, AzureCodeGrant, AzureDeviceCode, Token } from 'ads-adal-library';
import { ConnectionProfile } from '../models/connectionProfile';
import { AccountStore } from './accountStore';
import providerSettings from '../azure/providerSettings';

function getAppDataPath(): string {
    let platform = process.platform;
    switch (platform) {
        case 'win32': return process.env['APPDATA'] || path.join(process.env['USERPROFILE'], 'AppData', 'Roaming');
        case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support');
        case 'linux': return process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
        default: throw new Error('Platform not supported');
    }
}

function getDefaultLogLocation(): string {
    return path.join(getAppDataPath(), 'vscode-mssql');
}

async function findOrMakeStoragePath(): Promise<string | undefined> {
    let defaultLogLocation = getDefaultLogLocation();
    let storagePath = path.join(defaultLogLocation, 'AAD');

    try {
        await fs.mkdir(defaultLogLocation, { recursive: true });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            console.log(`Creating the base directory failed... ${e}`);
            return undefined;
        }
    }

    try {
        await fs.mkdir(storagePath, { recursive: true });
    } catch (e) {
        if (e.code !== 'EEXIST') {
            console.error(`Initialization of vscode-mssql storage failed: ${e}`);
            console.error('Azure accounts will not be available');
            return undefined;
        }
    }

    console.log('Initialized vscode-mssql storage.');
    return storagePath;
}

export class AzureController {

    private authRequest: AzureAuthRequest;
    private azureStringLookup: AzureStringLookup;
    private azureUserInteraction: AzureUserInteraction;
    private azureErrorLookup: AzureErrorLookup;
    private azureMessageDisplayer: AzureMessageDisplayer;
    private cacheService: SimpleTokenCache;
    private storageService: StorageService;
    private context: vscode.ExtensionContext;
    private logger: AzureLogger;

    constructor(context: vscode.ExtensionContext, logger?: AzureLogger) {
        this.context = context;
        if (!this.logger) {
            this.logger = new AzureLogger();
        }
    }
    public async init(): Promise<void> {
        this.authRequest = new AzureAuthRequest(this.context, this.logger);
        await this.authRequest.startServer();
        let storagePath = await findOrMakeStoragePath();
        let credentialStore = new CredentialStore();
        this.cacheService = new SimpleTokenCache('aad', storagePath, true, credentialStore);
        await this.cacheService.init();
        this.storageService = this.cacheService.db;
        this.azureStringLookup = new AzureStringLookup();
        this.azureUserInteraction = new AzureUserInteraction(this.authRequest.getState());
        this.azureErrorLookup = new AzureErrorLookup();
        this.azureMessageDisplayer = new AzureMessageDisplayer();
    }

    public async getTokens(profile: ConnectionProfile, accountStore: AccountStore): Promise<ConnectionProfile> {
        let account: IAccount;
        let config = vscode.workspace.getConfiguration('mssql').get('azureActiveDirectory');
        if (config === utils.azureAuthTypeToString(AzureAuthType.AuthCodeGrant)) {
            let azureCodeGrant = await this.createAuthCodeGrant();
            account = await azureCodeGrant.startLogin();
            await accountStore.addAccount(account);
            const token = await azureCodeGrant.getAccountSecurityToken(
                account, azureCodeGrant.getHomeTenant(account).id, providerSettings.resources.databaseResource
            );
            profile.azureAccountToken = token.token;
            profile.email = account.displayInfo.email;
            profile.accountId = account.key.id;
        } else if (config === utils.azureAuthTypeToString(AzureAuthType.DeviceCode)) {
            let azureDeviceCode = await this.createDeviceCode();
            account = await azureDeviceCode.startLogin();
            await accountStore.addAccount(account);
            const token = await azureDeviceCode.getAccountSecurityToken(
                account, azureDeviceCode.getHomeTenant(account).id, providerSettings.resources.databaseResource
            );
            profile.azureAccountToken = token.token;
            profile.email = account.displayInfo.email;
            profile.accountId = account.key.id;
        }
        return profile;
    }

    public async refreshTokenWrapper(profile, accountStore, accountAnswer): Promise<ConnectionProfile> {
        let account = accountStore.getAccount(accountAnswer.key.id);
        if (!account) {
            throw new Error('account not found');
        }
        profile.azureAccountToken = await this.refreshToken(account, accountStore);
        profile.email = account.displayInfo.email;
        profile.accountId = account.key.id;
        return profile;
    }

    public async refreshToken(account: IAccount, accountStore: AccountStore): Promise<string> {
        let token: Token;
        if (account.properties.azureAuthType === 0) {
            // Auth Code Grant
            let azureCodeGrant = await this.createAuthCodeGrant();
            let newAccount = await azureCodeGrant.refreshAccess(account);
            await accountStore.addAccount(newAccount);
            token = await azureCodeGrant.getAccountSecurityToken(
                account, azureCodeGrant.getHomeTenant(account).id, providerSettings.resources.databaseResource
                );
        } else if (account.properties.azureAuthType === 1) {
            // Auth Device Code
            let azureDeviceCode = await this.createDeviceCode();
            let newAccount = await azureDeviceCode.refreshAccess(account);
            await accountStore.addAccount(newAccount);
            token = await azureDeviceCode.getAccountSecurityToken(
                account, azureDeviceCode.getHomeTenant(account).id, providerSettings.resources.databaseResource
                );
        }
        return token.token;
    }

    private async createAuthCodeGrant(): Promise<AzureCodeGrant> {
        let azureLogger = new AzureLogger();
        await this.init();
        return new AzureCodeGrant(
            providerSettings, this.storageService, this.cacheService, azureLogger,
            this.azureMessageDisplayer, this.azureErrorLookup, this.azureUserInteraction,
            this.azureStringLookup, this.authRequest
        );
    }

    private async createDeviceCode(): Promise<AzureDeviceCode> {
        let azureLogger = new AzureLogger();
        await this.init();
        return new AzureDeviceCode(
            providerSettings, this.storageService, this.cacheService, azureLogger,
            this.azureMessageDisplayer, this.azureErrorLookup, this.azureUserInteraction,
            this.azureStringLookup, this.authRequest
        );
    }
}