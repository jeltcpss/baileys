import type { Logger } from 'pino'
import type { IAudioMetadata } from 'music-metadata'
import { Boom } from '@hapi/boom'
import * as Crypto from 'crypto'
import { Readable, Transform } from 'stream'
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs'
import { exec } from 'child_process'
import { tmpdir } from 'os'
import { URL } from 'url'
import { join } from 'path'
import { once } from 'events'
import got, { Options, Response } from 'got'
import { MessageType, WAMessageContent, WAProto, WAGenericMediaMessage, WAMediaUpload, MediaType, DownloadableMessage } from '../Types'
import { generateMessageID } from './generics'
import { hkdf } from './crypto'
import { DEFAULT_ORIGIN } from '../Defaults'

export const hkdfInfoKey = (type: MediaType) => {
    let str: string = type
    if(type === 'sticker') str = 'image'
    if(type === 'md-app-state') str = 'App State'
    
	let hkdfInfo = str[0].toUpperCase() + str.slice(1)
	return `WhatsApp ${hkdfInfo} Keys`
}
/** generates all the keys required to encrypt/decrypt & sign a media message */
export function getMediaKeys(buffer, mediaType: MediaType) {
    if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
    }
    // expand using HKDF to 112 bytes, also pass in the relevant app info
    const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80),
    }
}
/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (
    path: string,
    destPath: string,
    time: string,
    size: { width: number; height: number },
) =>
    new Promise((resolve, reject) => {
        const cmd = `ffmpeg -ss ${time} -i ${path} -y -s ${size.width}x${size.height} -vframes 1 -f image2 ${destPath}`
        exec(cmd, (err) => {
            if (err) reject(err)
            else resolve()
        })
    }) as Promise<void>

export const compressImage = async (bufferOrFilePath: Readable | Buffer | string) => {
    if(bufferOrFilePath instanceof Readable) {
        bufferOrFilePath = await toBuffer(bufferOrFilePath)
    }
    const { read, MIME_JPEG, RESIZE_BILINEAR } = await import('jimp')
    const jimp = await read(bufferOrFilePath as any)
    const result = await jimp
        .quality(50)
        .resize(32, 32, RESIZE_BILINEAR)
        .getBufferAsync(MIME_JPEG)
    return result
}
export const generateProfilePicture = async (mediaUpload: WAMediaUpload) => {
    let bufferOrFilePath: Buffer | string
    if(Buffer.isBuffer(mediaUpload)) {
        bufferOrFilePath = mediaUpload
    } else if('url' in mediaUpload) {
        bufferOrFilePath = mediaUpload.url.toString()
    } else {
        bufferOrFilePath = await toBuffer(mediaUpload.stream)
    }
    
    const { read, MIME_JPEG, RESIZE_BILINEAR } = await import('jimp')
    const jimp = await read(bufferOrFilePath as any)
    const min = Math.min(jimp.getWidth (), jimp.getHeight ())
    const cropped = jimp.crop (0, 0, min, min)
    return {
        img: await cropped
            .quality(50)
            .resize(640, 640, RESIZE_BILINEAR)
            .getBufferAsync(MIME_JPEG),
    }
}
/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
    const media = Object.values(message)[0] as WAGenericMediaMessage
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString ('base64')
}
export async function getAudioDuration (buffer: Buffer | string) {
    const musicMetadata = await import ('music-metadata')
    let metadata: IAudioMetadata
    if(Buffer.isBuffer(buffer)) {
        metadata = await musicMetadata.parseBuffer(buffer, null, { duration: true })
    } else {
        const rStream = createReadStream(buffer)
        metadata = await musicMetadata.parseStream(rStream, null, { duration: true })
        rStream.close()
    }
    return metadata.format.duration;
}
export const toReadable = (buffer: Buffer) => {
    const readable = new Readable({ read: () => {} })
    readable.push(buffer)
    readable.push(null)
    return readable
}
export const toBuffer = async(stream: Readable) => {
    let buff = Buffer.alloc(0)
    for await(const chunk of stream) {
        buff = Buffer.concat([ buff, chunk ])
    }
    return buff
}
export const getStream = async (item: WAMediaUpload) => {
    if(Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' }
    if('stream' in item) return { stream: item.stream, type: 'readable' }
    if(item.url.toString().startsWith('http://') || item.url.toString().startsWith('https://')) {
        return { stream: await getGotStream(item.url), type: 'remote' }
    }
    return { stream: createReadStream(item.url), type: 'file' }
}
/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
    file: string, 
    mediaType: 'video' | 'image', 
    options: {
        logger?: Logger
    }
) {
    let thumbnail: string
    if(mediaType === 'image') {
        const buff = await compressImage(file)
        thumbnail = buff.toString('base64')
    } else if(mediaType === 'video') {
        const imgFilename = join(tmpdir(), generateMessageID() + '.jpg')
        try {
            await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 })
            const buff = await fs.readFile(imgFilename)
            thumbnail = buff.toString('base64')

            await fs.unlink(imgFilename)
        } catch (err) {
            options.logger?.debug('could not generate video thumb: ' + err)
        }
    }
    
    return thumbnail
}
export const getGotStream = async(url: string | URL, options: Options & { isStream?: true } = {}) => {
    const fetched = got.stream(url, { ...options, isStream: true })
    await new Promise((resolve, reject) => {
        fetched.once('error', reject)
        fetched.once('response', ({ statusCode }: Response) => {
            if (statusCode >= 400) {
                reject(
					new Boom(
                    'Invalid code (' + statusCode + ') returned', 
                    { statusCode }
                ))
            } else {
                resolve(undefined)
            }
        })
    })
    return fetched
} 
export const encryptedStream = async(media: WAMediaUpload, mediaType: MediaType, saveOriginalFileIfRequired = true) => {
    const { stream, type } = await getStream(media)

    const mediaKey = Crypto.randomBytes(32)
    const {cipherKey, iv, macKey} = getMediaKeys(mediaKey, mediaType)
    // random name
    const encBodyPath = join(tmpdir(), mediaType + generateMessageID() + '.enc')
    const encWriteStream = createWriteStream(encBodyPath)
    let bodyPath: string
    let writeStream: WriteStream
    let didSaveToTmpPath = false
    if(type === 'file') {
        bodyPath = (media as any).url
    } else if(saveOriginalFileIfRequired) {
        bodyPath = join(tmpdir(), mediaType + generateMessageID())
        writeStream = createWriteStream(bodyPath)
        didSaveToTmpPath = true
    }
    
    let fileLength = 0
    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
    let hmac = Crypto.createHmac('sha256', macKey).update(iv)
    let sha256Plain = Crypto.createHash('sha256')
    let sha256Enc = Crypto.createHash('sha256')

    const onChunk = (buff: Buffer) => {
        sha256Enc = sha256Enc.update(buff)
        hmac = hmac.update(buff)
        encWriteStream.write(buff)
    }
    for await(const data of stream) {
        fileLength += data.length
        sha256Plain = sha256Plain.update(data)
        if(writeStream) {
            if(!writeStream.write(data)) await once(writeStream, 'drain')
        }
        onChunk(aes.update(data))
    }
    onChunk(aes.final())

    const mac = hmac.digest().slice(0, 10)
    sha256Enc = sha256Enc.update(mac)
    
    const fileSha256 = sha256Plain.digest()
    const fileEncSha256 = sha256Enc.digest()
    
    encWriteStream.write(mac)
    encWriteStream.end()

    writeStream && writeStream.end()

    return {
        mediaKey,
        encBodyPath,
        bodyPath,
        mac,
        fileEncSha256,
        fileSha256,
        fileLength,
        didSaveToTmpPath
    }
}

const DEF_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16

const toSmallestChunkSize = (num: number) => {
    return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE
}

type MediaDownloadOptions = {
    startByte?: number
    endByte?: number
}

export const downloadContentFromMessage = async(
    { mediaKey, directPath, url }: DownloadableMessage,
    type: MediaType,
    { startByte, endByte }: MediaDownloadOptions = { }
) => {
    const downloadUrl = url || `https://${DEF_HOST}${directPath}`
    let bytesFetched = 0
    let startChunk = 0
    let firstBlockIsIV = false
    // if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
    if(startByte) {
        const chunk = toSmallestChunkSize(startByte || 0)
        if(chunk) {
            startChunk = chunk-AES_CHUNK_SIZE
            bytesFetched = chunk

            firstBlockIsIV = true
        }
    }
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0)+AES_CHUNK_SIZE : undefined
    let rangeHeader: string | undefined = undefined
    if(startChunk || endChunk) {
        rangeHeader = `bytes=${startChunk}-`
        if(endChunk) rangeHeader += endChunk
    }
    // download the message
    const fetched = await getGotStream(downloadUrl, {
        headers: { 
            Origin: DEFAULT_ORIGIN,
            Range: rangeHeader
        }
    })

    let remainingBytes = Buffer.from([])
    const { cipherKey, iv } = getMediaKeys(mediaKey, type)

    let aes: Crypto.Decipher

    const pushBytes = (bytes: Buffer, push: (bytes: Buffer) => void) => {
        if(startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte-bytesFetched, 0)
            const end = bytesFetched+bytes.length < endByte ? undefined : Math.max(endByte-bytesFetched, 0)
            
            push(bytes.slice(start, end))
    
            bytesFetched += bytes.length
        } else {
            push(bytes)
        }
    }

    const output = new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk])
            
            const decryptLength = toSmallestChunkSize(data.length)
            remainingBytes = data.slice(decryptLength)
            data = data.slice(0, decryptLength)

            if(!aes) {
                let ivValue = iv
                if(firstBlockIsIV) {
                    ivValue = data.slice(0, AES_CHUNK_SIZE)
                    data = data.slice(AES_CHUNK_SIZE)
                }

                aes = Crypto.createDecipheriv("aes-256-cbc", cipherKey, ivValue)
                // if an end byte that is not EOF is specified
                // stop auto padding (PKCS7) -- otherwise throws an error for decryption
                if(endByte) {
                    aes.setAutoPadding(false)
                }
                
            }

            try {
                pushBytes(aes.update(data), b => this.push(b))
                callback()
            } catch(error) {
                callback(error)
            }  
        },
        final(callback) {
            try {
                pushBytes(aes.final(), b => this.push(b))
                callback()
            } catch(error) {
                callback(error)
            }
        },
    })
    return fetched.pipe(output, { end: true })
}

/**
 * Decode a media message (video, image, document, audio) & return decrypted buffer
 * @param message the media message you want to decode
 */
export async function decryptMediaMessageBuffer(message: WAMessageContent): Promise<Readable> {
    /* 
        One can infer media type from the key in the message
        it is usually written as [mediaType]Message. Eg. imageMessage, audioMessage etc.
    */
    const type = Object.keys(message)[0] as MessageType
    if(
		!type ||
		type === 'conversation' || 
		type === 'extendedTextMessage'
	) {
        throw new Boom(`no media message for "${type}"`, { statusCode: 400 })
    }
    if (type === 'locationMessage' || type === 'liveLocationMessage') {
        const buffer = Buffer.from(message[type].jpegThumbnail)
        const readable = new Readable({ read: () => {} })
        readable.push(buffer)
        readable.push(null)
        return readable
    }
    let messageContent: WAGenericMediaMessage
    if (message.productMessage) {
        const product = message.productMessage.product?.productImage
        if (!product) throw new Boom('product has no image', { statusCode: 400 })
        messageContent = product
    } else {
        messageContent = message[type]
    }
    return downloadContentFromMessage(messageContent, type.replace('Message', '') as MediaType)
}
export function extensionForMediaMessage(message: WAMessageContent) {
    const getExtension = (mimetype: string) => mimetype.split(';')[0].split('/')[1]
    const type = Object.keys(message)[0] as MessageType
    let extension: string
    if(
		type === 'locationMessage' || 
		type === 'liveLocationMessage' || 
		type === 'productMessage'
	) {
        extension = '.jpeg'
    } else {
        const messageContent = message[type] as
                                | WAProto.VideoMessage
                                | WAProto.ImageMessage
                                | WAProto.AudioMessage
                                | WAProto.DocumentMessage
        extension = getExtension (messageContent.mimetype)
    }
    return extension
}