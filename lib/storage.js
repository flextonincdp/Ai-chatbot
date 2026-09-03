const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Readable } = require('stream');

const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);
const unlink = promisify(fs.unlink);
const stat = promisify(fs.stat);
const rename = promisify(fs.rename);

// Storage interface
class StorageProvider {
  async put(localPathOrBuffer, storageKey, mimeType) { throw new Error('Not implemented'); }
  async get(storageKey, localDest) { throw new Error('Not implemented'); }
  async delete(storageKey) { throw new Error('Not implemented'); }
  async exists(storageKey) { throw new Error('Not implemented'); }
  async metadata(storageKey) { throw new Error('Not implemented'); }
  async getSignedUrl(storageKey, expiresIn = 3600) { throw new Error('Not implemented'); }
  async getStream(storageKey) { throw new Error('Not implemented'); }
}

class LocalStorageAdapter extends StorageProvider {
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
  }

  _getFullPath(storageKey) {
    const safeKey = storageKey.replace(/\.\./g, '');
    return path.join(this.baseDir, safeKey);
  }

  async put(localPathOrBuffer, storageKey, mimeType) {
    const dest = this._getFullPath(storageKey);
    await mkdir(path.dirname(dest), { recursive: true });
    
    if (Buffer.isBuffer(localPathOrBuffer)) {
      await promisify(fs.writeFile)(dest, localPathOrBuffer);
    } else {
      try {
        await rename(localPathOrBuffer, dest);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await copyFile(localPathOrBuffer, dest);
          await unlink(localPathOrBuffer);
        } else {
          throw err;
        }
      }
    }
    return storageKey;
  }

  async get(storageKey, localDest) {
    const src = this._getFullPath(storageKey);
    await copyFile(src, localDest);
  }

  async delete(storageKey) {
    const src = this._getFullPath(storageKey);
    try {
      await unlink(src);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async exists(storageKey) {
    const src = this._getFullPath(storageKey);
    try {
      await stat(src);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async metadata(storageKey) {
    const src = this._getFullPath(storageKey);
    const s = await stat(src);
    return {
      size: s.size,
      mtime: s.mtime
    };
  }

  async getSignedUrl(storageKey, expiresIn = 3600) {
    // Local fallback just returns a path - production will use MinIO
    return `/uploads/${storageKey.replace(/\.\./g, '')}`;
  }

  async getStream(storageKey) {
    const src = this._getFullPath(storageKey);
    return fs.createReadStream(src);
  }
}

class S3StorageAdapter extends StorageProvider {
  constructor() {
    super();
    this.bucket = process.env.MINIO_BUCKET || 'knowledge-studio';
    
    // AWS SDK v3 Client
    this.client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
      region: process.env.MINIO_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
      },
      forcePathStyle: true, // Required for MinIO
    });
  }

  async put(localPathOrBuffer, storageKey, mimeType) {
    let body;
    if (Buffer.isBuffer(localPathOrBuffer)) {
      body = localPathOrBuffer;
    } else {
      body = fs.createReadStream(localPathOrBuffer);
    }
    
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      Body: body,
      ContentType: mimeType || 'application/octet-stream'
    });
    
    await this.client.send(command);
    
    // Clean up local file if we read from path
    if (!Buffer.isBuffer(localPathOrBuffer)) {
       try { await unlink(localPathOrBuffer); } catch(e) {}
    }
    
    return storageKey;
  }

  async get(storageKey, localDest) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    });
    
    const response = await this.client.send(command);
    
    return new Promise((resolve, reject) => {
      if (response.Body instanceof Readable) {
        const fileStream = fs.createWriteStream(localDest);
        response.Body.pipe(fileStream)
          .on('error', reject)
          .on('close', () => resolve());
      } else {
        reject(new Error("Response body is not a readable stream"));
      }
    });
  }

  async delete(storageKey) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    });
    await this.client.send(command);
  }

  async exists(storageKey) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: storageKey
      });
      await this.client.send(command);
      return true;
    } catch (err) {
      if (err.name === 'NotFound') return false;
      throw err;
    }
  }

  async metadata(storageKey) {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    });
    const response = await this.client.send(command);
    return {
      size: response.ContentLength,
      mtime: response.LastModified
    };
  }

  async getSignedUrl(storageKey, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    });
    return await getSignedUrl(this.client, command, { expiresIn });
  }

  async getStream(storageKey) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    });
    const response = await this.client.send(command);
    if (response.Body instanceof Readable) {
      return response.Body;
    }
    throw new Error("Response body is not a readable stream");
  }
}

// Factory
function getStorageProvider() {
  const providerType = process.env.OBJECT_STORAGE_PROVIDER || 'local';
  
  if (providerType === 'local') {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    return new LocalStorageAdapter(uploadsDir);
  }
  
  if (providerType === 's3' || providerType === 'minio') {
    return new S3StorageAdapter();
  }
  
  throw new Error(`Unknown storage provider: ${providerType}`);
}

module.exports = {
  getStorageProvider
};
