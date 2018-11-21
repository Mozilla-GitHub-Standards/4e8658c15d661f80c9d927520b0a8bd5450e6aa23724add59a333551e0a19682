const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const config = require('./config.js')
const { headNode, getNodeById, getAllNodes } = require('./nodes.js')

const snakepitPrefix = 'sp'
const containerNameParser = /sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/g;

var agent = new https.Agent({ 
    key: config.lxdKey, 
    cert: config.lxdCert,
    rejectUnauthorized: false
})

var headInfo
var exports = module.exports = {}

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

function sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function wrapLxdResponse (node, promise) {
    let [err, response] = await to(promise)
    if (err) {
        console.log(err)
        throw err.message
    }
    let data = response.data
    switch(data.type) {
        case 'sync':
            if (data.metadata && data.metadata.err) {
                throw data.metadata.err
            }
            return data.metadata
        case 'async':
            console.log('Forwarding:', data.operation + '/wait')
            return await wrapLxdResponse(node, axios.get(node.lxdEndpoint + data.operation + '/wait', { httpsAgent: agent }))
        case 'error':
            throw data.error
    }
}

function callLxd(method, node, resource, data, options) {
    let axiosConfig = assign({
        method: method,
        url: getUrl(node, resource),
        httpsAgent: agent,
        data: data
    }, options || {})
    //console.log(method, axiosConfig, data)
    return wrapLxdResponse(node, axios(axiosConfig))
}

function lxdGet (node, resource, options) {
    return callLxd('get', node, resource, undefined, options)
}

function lxdDelete (node, resource, options) {
    return callLxd('delete', node, resource, undefined, options)
}

function lxdPut (node, resource, data, options) {
    return callLxd('put', node, resource, data, options)
}

function lxdPost (node, resource, data, options) {
    return callLxd('post', node, resource, data, options)
}

function getContainerName (nodeId, pitId, instance) {
    return snakepitPrefix + '-' + nodeId + '-' + pitId + '-' + instance
}

function parseContainerName (containerName) {
    let match = containerNameParser.exec(containerName)
    return match && [match[1], match[2], match[3]]
}

async function getHeadInfo () {
    if (headInfo) {
        return headInfo
    }
    return headInfo = await lxdGet(headNode, '')
}
exports.getHeadInfo = getHeadInfo

async function testAsync () {
    return await getHeadInfo()
}

exports.test = function () {
    testAsync()
    .then(result => console.log(result))
    .catch(err => console.log(err))
}

async function getHeadCertificate () {
    let info = await getHeadInfo()
    return info.environment && info.environment.certificate
}

function getUrl (node, resource) {
    return node.lxdEndpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function getContainersOnNode (node) {
    let results = await to(lxdGet(node, 'containers'))
    return results.filter(result => parseContainerName(result))
}

async function setContainerState (node, containerName, state, force, stateful) {
    await lxdPut(node, 'containers/' + containerName + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

async function pushFile (containerName, targetPath, content) {
    let containerInfo = parseContainerName(containerName)
    let node = getNodeById(containerInfo[1])
    await lxdPost(
        node, 
        'containers/' + containerName + '/files?path=' + targetPath, 
        content, 
        {
            headers: { 
                'Content-Type': 'application/octet-stream',
                'X-LXD-type':   'file', 
                'X-LXD-write':  'overwrite'
            } 
        }
    )
}

async function addContainer (node, imageHash, containerName, pitInfo, options, script) {
    let cert = await getHeadCertificate()
    let containerConfig = assign({
        name: containerName,
        architecture: 'x86_64',
        profiles: [],
        ephemeral: false,
        devices: {
            'root': {
				path: '/',
				pool: 'default',
				type: 'disk'
			}
        },
        source: {
            type:        'image',
            mode:        'pull',
            server:      config.lxdEndpoint,
            protocol:    'lxd',
            certificate: cert,
            fingerprint: imageHash
        },
    }, options || {})
    await lxdPost(node, 'containers', containerConfig)
    if (pitInfo) {
        let vars = []
        for (let name of Object.keys(pitInfo)) {
            vars.push(name + '=' + pitInfo[name] + '\n')
        }
        await pushFile(containerName, '/etc/pit_info', vars.join(''))
    }
    if (script) {
        await pushFile(containerName, '/usr/bin/script.sh', script)
    }
}

async function createPit (pitId, drives, workers) {
    try {
        let daemonHash = (await lxdGet(headNode, 'images/aliases/snakepit-daemon')).target
        let workerHash = (await lxdGet(headNode, 'images/aliases/snakepit-worker')).target

        let physicalNodes = { [headNode.lxdEndpoint]: headNode }
        for (let worker of workers) {
            // we just need one virtual node representant of/on each physical node
            physicalNodes[worker.node.lxdEndpoint] = worker.node
        }
        let network
        let endpoints = Object.keys(physicalNodes)
        if (endpoints.length > 1) {
            network = snakepitPrefix + pitId
            await Parallel.each(endpoints, async function (localEndpoint) {
                let tunnelConfig = {}
                for (let remoteEndpoint of endpoints) {
                    if (localEndpoint !== remoteEndpoint) {
                        let tunnel = 'tunnel.' + physicalNodes[remoteEndpoint].id
                        tunnelConfig[tunnel + '.protocol'] = 'vxlan',
                        tunnelConfig[tunnel + '.id'] = pitId
                    }
                }
                await lxdPost(physicalNodes[localEndpoint], 'networks', {
                    name: network,
                    config: tunnelConfig
                })
            })
        }

        let daemonDevices = {}
        if (network) {
            daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        if (drives) {
            for (let dest of Object.keys(drives)) {
                daemonDevices[dest] = {
                    path: '/' + dest,
                    source: drives[dest],
                    type: 'disk'
                }
            }
        }
        let daemonContainerName = getContainerName(headNode.id, pitId, 'd')
        let pitInfo = {
            JOB_NUMBER:         pitId,
            PIT_DAEMON_HOST:    daemonContainerName + '.lxd',
            PIT_WORKER_NUMBER:  workers.length,
            PIT_WORKER_PREFIX:  snakepitPrefix + pitId + '-',
            PIT_WORKER_POSTFIX: '.lxd'
        }

        await addContainer(headNode, daemonHash, daemonContainerName, pitInfo, { devices: daemonDevices })

        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worer.node.id, pitId, workers.indexOf(worker))
            let workerDevices = {}
            if (network) {
                workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
            }
            await addContainer(worker.node, workerHash, containerName, pitInfo, { devices: workerDevices }, worker.script)
        })

        await setContainerState(headNode, daemonContainerName, 'start')
        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worer.node.id, pitId, workers.indexOf(worker))
            await setContainerState(worker.node, containerName, 'start')
        })
    } catch (ex) {
        await dropPit(pitId)
        throw ex
    }
}
exports.createPit = createPit

async function dropPit (pitId) {
    let nodes = {}
    await Parallel.each(getAllNodes(), async node => {
        let [err, containers] = await to(getContainersOnNode(node))
        if (containers) {
            for (let containerName of containers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] === pitId) {
                    nodes[node.lxdEndpoint] = node
                    await to(lxdDelete(node, 'containers/' + containerName))
                }
            }
        }
    })
    if (nodes.length > 1) {
        Parallel.each(Object.keys(nodes), async function (endpoint) {
            await to(lxdDelete(nodes[endpoint], 'networks/' + snakepitPrefix + pitId))
        })
    }
}
exports.dropPit = dropPit 

async function getPits () {
    let [err, containers] = await to(getContainersOnNode(headNode))
    let pitIds = {}
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        if (containerInfo) {
            pitIds[containerInfo[1]] = true
        }
    }
    return Object.keys(pitIds)
}
exports.getPits = getPits