const fs = require('fs-extra')
const path = require('path')

const log = require('./utils/logger.js')
const { runScript } = require('./utils/scripts.js')
const clusterEvents = require('./utils/clusterEvents.js')
const config = require('./config.js')
const pitRunner = require('./pitRunner.js')
const reservations = require('./reservations.js')
const Job = require('./models/Job-model.js')


const jobStates = Job.jobStates

var exports = module.exports = {}

var preparations = {}

function getBasicEnv (job) {
    return {
        JOB_NUMBER: job.id,
        DATA_ROOT:  '/data',
        JOB_DIR:    job.getDir()
    }
}

function getPreparationEnv (job) {
    let env = getBasicEnv(job)
    if (job.continues) {
        env.CONTINUE_JOB_NUMBER = job.continues
    }
    return env
}

async function prepareJob (job) {
    let env = getPreparationEnv(job)
    await job.setState(jobStates.PREPARING)
    return runScript('prepare.sh', env, async (code, stdout, stderr) => {
        if (code == 0 && fs.existsSync(job.getDir()) && job.state == jobStates.PREPARING) {
            await job.setState(jobStates.WAITING)
        } else {
            if (job.state != jobStates.STOPPING) {
                appendError(job, 'Problem during preparation step - exit code: ' + code + '\n' + stdout + '\n' + stderr)  
            }
            await job.setState(jobStates.DONE)
        }
    })
}
exports.prepareJob = prepareJob

async function startJob (job) {
    await job.setState(jobStates.STARTING)
    let user = await job.getUser()
    let jobEnv = getBasicEnv(job)
    
    jobEnv.JOB_DIR = '/data/rw/pit'
    jobEnv.SRC_DIR = jobEnv.WORK_DIR = '/data/rw/pit/src'
    let shares = {
        '/ro/shared':    path.join(config.mountRoot, 'shared'),
        '/data/rw/home': user.getDirExternal()
    }
    jobEnv.DATA_ROOT = '/data'
    jobEnv.SHARED_DIR = '/data/ro/shared'
    jobEnv.USER_DIR = '/data/rw/home'
    for (let group of (await user.getGroups())) {
        shares['/data/rw/group-' + group] = group.getDirExternal()
        jobEnv[group.toUpperCase() + '_GROUP_DIR'] = '/data/rw/group-' + group
    }

    let processGroups = await job.getProcessGroups({ 
        include: [
            {
                model: Process,
                require: true,
                include: 
                [
                    {
                        model: Allocation,
                        require: false,
                        include: [
                            {
                                model: Resource,
                                require: true
                            }
                        ]
                    }
                ]
            }
        ]
    })

    let workers = []
    jobEnv.NUM_GROUPS = processGroups.length
    for(let processGroup of processGroups) {
        jobEnv['NUM_PROCESSES_GROUP' + processGroup.index] = processGroup.Processes.length
        for(let jobProcess of processGroup.Processes) {
            jobEnv['HOST_GROUP' + gIndex + '_PROCESS' + pIndex] = 
                pitRunner.getWorkerHost(job.id, jobProcess.node, workers.length)
            let gpus = {}
            for(let allocation of jobProcess.Allocations) {
                let resource = allocation.Resource
                if (resource.type == 'cuda') {
                    gpus['gpu' + resource.index] = {
                        type:  'gpu',
                        id:    '' + resource.index
                    }
                }
            }
            workers.push({
                node:    node,
                options: { devices: gpus },
                env:     Object.assign({
                            GROUP_INDEX:   processReservation.groupIndex,
                            PROCESS_INDEX: processReservation.processIndex
                         }, jobEnv),
                script:  job.script
            })
        }
    }
    try {
        await pitRunner.startPit(job.id, shares, workers)
        await job.setState(jobStates.RUNNING)
    } catch (ex) {
        log.error('START PROBLEM', ex.toString())
        await cleanJob(job, 'Problem during startup: ' + ex.toString())
    }
}
exports.startJob = startJob

async function stopJob (job, reason) {
    try {
        if (job.state == jobStates.PREPARING && preparations[job.id]) {
            await job.setState(jobStates.STOPPING, reason)
            preparations[job.id].kill()
            delete preparations[job.id]
    
        } else if (job.state == jobStates.RUNNING) {
            await job.setState(jobStates.STOPPING, reason)
            await pitRunner.stopPit(job.id)
        } else {
            return
        }
    } catch (ex) {
        await cleanJob(job, 'Problem during stopping')
        return
    }
    await cleanJob()
}
exports.stopJob = stopJob

async function cleanJob (job, reason) {
    await job.setState(jobStates.CLEANING, reason)
    utils.runScript('clean.sh', getPreparationEnv(job), async (code, stdout, stderr) => {
        await job.setState(jobStates.DONE, code > 0 ? ('Problem during cleaning step - exit code: ' + code + '\n' + stderr) : undefined)
    })
}
exports.cleanJob = cleanJob

async function resimulateReservations() {
    let jobs = []
    for(let job of (await Job.findAll({ where: { '$between': [jobStates.PREPARING, jobStates.WAITING] } }))) {
        if (reservations.canAllocate(job.resourceRequest, job.user)) {
            await stopJob(job, 'Cluster cannot fulfill resource request anymore')
        }
    }
}

clusterEvents.on('restricted', resimulateReservations)

/*
clusterEvents.on('pitStarting', pitId => {
    let job = db.jobs[pitId]
    if (job) {
        job.setState(jobStates.STARTING)
    }
})
*/

clusterEvents.on('pitStopping', async pitId => {
    let job = await Job.findByPk(pitId)
    if (job) {
        await job.setState(jobStates.STOPPING)
    }
})

clusterEvents.on('pitStopped', async pitId => {
    let job = await Job.findByPk(pitId)
    if (job) {
        await cleanJob(job)
    }
})

clusterEvents.on('pitReport', pits => {
    pits = pits.reduce((hashMap, obj) => {
        hashMap[obj] = true
        return hashMap
    }, {})
    for (let jobId of Object.keys(db.jobs)) {
        let job = db.jobs[jobId]
        if (job.state == jobStates.RUNNING && !pits[jobId]) {
            stopJob(job)
        }
    }
})

exports.startup = async function () {
    for (let job of (await Job.findAll({ where: { state: jobStates.PREPARING } }))) {
        await cleanJob(job, 'Job interrupted during preparation')
    }
    for (let job of (await Job.findAll({ where: { state: jobStates.CLEANING } }))) {
        await cleanJob(job)
    }
}

exports.tick = function() {
    /*
    store.lockAsyncRelease('jobs', release => {
        let goon = () => {
            release()
            setTimeout(exports.tick, config.pollInterval)
        }
        let running = {}
        for(let job of Object.keys(db.jobs).map(k => db.jobs[k])) {
            let stateTime = new Date(job.stateChanges[job.state]).getTime()
            if (
                job.state == jobStates.NEW && 
                Object.keys(preparations).length < config.maxParallelPrep
            ) {
                preparations[job.id] = prepareJob(job)
            } else if (
                job.state == jobStates.DONE && 
                stateTime + config.keepDoneDuration < Date.now()
            ) {
                job.setState(jobStates.ARCHIVED)
                delete db.jobs[job.id]
            } else if (job.state >= jobStates.STARTING && job.state <= jobStates.STOPPING) {
                running[job.id] = job
            }
        }
        for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
            for (let resource of node.resources || []) {
                if (resource.job && !running[resource.job]) {
                    delete resource.job
                }
            }   
        }
        for(let jobId of Object.keys(preparations)) {
            let job = db.jobs[jobId]
            if (job && job.state == jobStates.PREPARING) {
                if (new Date(job.stateChanges[job.state]).getTime() + config.maxPrepDuration < Date.now()) {
                    appendError(job, 'Job exceeded max preparation time')
                    stopJob(job)
                }
            } else {
                delete preparations[jobId]
                if (!job) {
                    console.error('Removed preparation process for orphan job ' + jobId)
                }
            }
        }
        if (db.schedule.length > 0) {
            let job = db.jobs[db.schedule[0]]
            if (job) {
                let clusterRequest = parseClusterRequest(job.clusterRequest)
                let clusterReservation = reservations.reserveCluster(clusterRequest, db.users[job.user], false)
                log.debug('STARTING SCHEDULED JOB', job.id, job.user, JSON.stringify(clusterRequest), clusterReservation)
                if (clusterReservation) {
                    db.schedule.shift()
                    startJob(job, clusterReservation, goon)
                } else {
                    goon()
                }
            } else {
                db.schedule.shift()
                goon()
            }
        } else {
            goon()
        }
    })
    */
}