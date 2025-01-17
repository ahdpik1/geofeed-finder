import batchPromises from "batch-promises";
import axios from "axios";
import WhoisParser from "bulk-whois-parser";
import CsvParser from "./csvParser";
import md5 from "md5";
import fs from "fs";
import moment from "moment";
import ipUtils from "ip-sub";
import webWhois from "whois";

export default class Finder {
    constructor(params) {
        this.params = params || {};
        this.cacheDir = this.params.cacheDir || ".cache/";
        this.csvParser = new CsvParser();
        this.downloadsOngoing = {};
        this.startTime = moment();

        this.cacheHeadersIndexFileName = this.cacheDir + "cache-index.json";
        this._importCacheHeaderIndex();

        this.connectors = ["ripe", "afrinic", "apnic", "arin", "lacnic"]
            .filter(key => this.params.include.includes(key));

        this.whois = new WhoisParser({
            repos: this.connectors,
            userAgent: "geofeed-finder"
        });
    };

    filterFunction = (inetnum) => {

        if (inetnum.geofeed) {
            return true;
        }

        if (inetnum?.remarks?.length > 0) {
            return inetnum.remarks.some(i => i.toLowerCase().startsWith("geofeed"));
        }

        return false;
    }

    getBlocks = () => {
        return this.whois
            .getObjects(["inetnum", "inet6num"], this.filterFunction,  ["inetnum", "inet6num", "remarks", "geofeed", "last-updated"])
            .then(blocks => {
                return [].concat.apply([], blocks).filter(i => !!i.inetnum || !!i.inet6num);
            })
            .catch(console.log);
    };

    _getFileName = (file) => {
        return this.cacheDir + md5(file);
    };

    _setGeofeedCacheHeaders = (response, cachedFile) => {
        let setAge = 3600 * 24 * this.params.defaultCacheDays; // 1 week (see draft)

        if (response.headers['cache-control']) {
            const maxAge = response.headers['cache-control']
                .split(",")
                .filter(h => h.includes("max-age"))
                .map(h => h.trim())
                .pop();

            if (maxAge) {
                const age = maxAge.split("=").pop();
                if (age && !isNaN(age)) {
                    setAge = Math.max(parseInt(age), 3600);
                }
            }
        }

        this.cacheHeadersIndex[cachedFile] = moment(this.startTime).add(setAge, "seconds");
    };

    _isCachedGeofeedValid = (cachedFile) => {

        return fs.existsSync(cachedFile) &&
            this.cacheHeadersIndex[cachedFile] &&
            moment(this.cacheHeadersIndex[cachedFile]).isSameOrAfter(this.startTime);
    };

    _importCacheHeaderIndex = () => {
        let tmp;
        if (fs.existsSync(this.cacheHeadersIndexFileName)) {
            tmp = JSON.parse(fs.readFileSync(this.cacheHeadersIndexFileName, 'utf-8'));
            for (let key in tmp) {
                tmp[key] = moment(tmp[key]);
            }
        }

        this.cacheHeadersIndex = tmp || {};
    };

    _persistCacheIndex = () => {
        fs.writeFileSync(this.cacheHeadersIndexFileName, JSON.stringify(this.cacheHeadersIndex));
    };

    logEntry = (inetnum, file, cache) => {
        console.log("inetnum:", inetnum, file, cache ? "[cache]" : "[download]");
    };

    _getGeofeedFile = (block) => {
        const file = block.geofeed;
        const cachedFile = this._getFileName(file);

        if (this._isCachedGeofeedValid(cachedFile)) {
            this.logEntry(block.inetnum, file, true);
            return Promise.resolve(fs.readFileSync(cachedFile, 'utf8'));
        } if (this.downloadsOngoing[cachedFile]) {
            this.logEntry(block.inetnum, file, true);
            return Promise.resolve(this.downloadsOngoing[cachedFile]);
        } else {
            this.logEntry(block.inetnum, file, false);
            this.downloadsOngoing[cachedFile] = axios({
                url: file,
                timeout: parseInt(this.params.downloadTimeout) * 1000,
                method: 'GET'
            })
                .then(response => {
                    fs.writeFileSync(cachedFile, response.data);
                    this._setGeofeedCacheHeaders(response, cachedFile);
                    return response.data;
                })
                .catch(error => {
                    console.log("error", file, error.code || (error.response || {}).status || error.message);
                    return null;
                });

            return this.downloadsOngoing[cachedFile];
        }
    };

    getGeofeedsFiles = (blocks) => {
        const out = []
        return batchPromises(5, blocks, block => {
            return this._getGeofeedFile(block)
                .then(data => {
                    out.push(this.validateGeofeeds(this.csvParser.parse(block.inetnum, data)));
                });
        })
            .then(() => {
                this._persistCacheIndex();
                return [].concat.apply([], out);
            })
            .then(data => {
                if (!this.params.includeZip) {
                    data.forEach(i => i.zip = null);
                }

                return data;
            });
    };

    validateGeofeeds = (geofeeds) => {
        return geofeeds
            .filter(geofeed => {
                const errors = geofeed.validate();

                if (errors.length > 0) {
                    console.log(`Error: ${geofeed} ${errors.join(", ")}`);
                }

                if (this.params.keepNonIso || errors.length === 0) {
                    return geofeed && !!geofeed.inetnum && !!geofeed.prefix &&
                        (ipUtils.isEqualPrefix(geofeed.inetnum, geofeed.prefix) || ipUtils.isSubnet(geofeed.inetnum, geofeed.prefix));
                }

                return false;
            });

    };

    getMostUpdatedInetnums = (inetnums) => {
        const index = {};
        for (let inetnum of inetnums) {
            index[inetnum.inetnum] = (!index[inetnum.inetnum] || index[inetnum.inetnum].lastUpdate < inetnum.lastUpdate) ?
                inetnum :
                index[inetnum.inetnum]
        }

        return Object.values(index);
    };

    setGeofeedPriority = (geofeeds) => {

        console.log("Validating prefixes ownership");
        const sortedByLessSpecificInetnum = geofeeds
            .sort((a, b) => {
                return ipUtils.sortByPrefixLength(a.inetnum, b.inetnum);
            });

        for (let item of sortedByLessSpecificInetnum) {
            item.af = ipUtils.getAddressFamily(item.prefix);
            const [ip, bits] = ipUtils.getIpAndCidr(item.prefix);
            item.binary = ipUtils._applyNetmask(ip, bits, item.af);
            item.bits = bits;
            item.ip = ip;
        }

        for (let n=1; n<sortedByLessSpecificInetnum.length; n++) {
            const moreSpecificInetnum = sortedByLessSpecificInetnum[n];

            for (let i=0; i<n; i++) { // For all the less specifics already visited
                const lessSpecificInetnum = sortedByLessSpecificInetnum[i];

                // If there is a less specific inetnum contradicting a more specific inetnum
                // Contradicting here means, the less specific is declaring something in the more specific range
                if (lessSpecificInetnum.valid &&
                    moreSpecificInetnum.af === lessSpecificInetnum.af &&
                    ((moreSpecificInetnum.bits === lessSpecificInetnum.bits && ipUtils._isEqualIP(moreSpecificInetnum.ip, lessSpecificInetnum.ip, moreSpecificInetnum.af)) ||
                        (ipUtils.isSubnetBinary(moreSpecificInetnum.binary, lessSpecificInetnum.binary)))) {
                    lessSpecificInetnum.valid = false;
                }
            }

        }

        return sortedByLessSpecificInetnum.filter(i => i.valid);
    };

    matchGeofeedFile = (remark) => {
        return remark.match(/\bhttps?:\/\/\S+/gi) || [];
    };

    translateObject = (object) => {
        let inetnum = object.inetnum || object.inet6num;
        let remarks = object.remarks;
        let geofeedField = object?.geofeed?.length ? this.matchGeofeedFile(object.geofeed).pop() : null;

        let inetnums = [inetnum];
        if (!inetnum.includes("/")) {
            const ips = inetnum.split("-").map(ip => ip.trim());
            inetnums = ipUtils.ipRangeToCidr(ips[0], ips[1]);
        }

        const lastUpdate = moment(object["last-updated"]);
        const remark = remarks.filter(i => i.toLowerCase().startsWith("geofeed"))[0];

        let geofeed = null;
        if (geofeedField) {
            geofeed = geofeedField;
        } else if (remark){
            geofeed = this.matchGeofeedFile(remark).pop();
        }

        return inetnums
            .map(inetnum => {

                return {
                    inetnum,
                    geofeed,
                    lastUpdate
                }
            });
    };

    getGeofeeds = () => {
        if (this.params.test) {
            const prefix = ipUtils.toPrefix(this.params.test?.trim());

            return this.getInetnum(prefix.split("/")[0])
                .then(answer => {
                    const items = answer.split("\n").map(i => i.toLowerCase());
                    const inetnumsLines = items.filter(i => i.startsWith("inetnum") || i.startsWith("netrange"));
                    const range = inetnumsLines[inetnumsLines.length - 1].split(":").slice(1).join(":");

                    let inetnum = range.trim();
                    if (!range.includes("/")) {
                        const [start, stop] = range.split("-").map(i => i.trim());
                        const inetnums = ipUtils.ipRangeToCidr(start, stop).filter(inetnum => ipUtils.isSubnet(inetnum, prefix));
                        inetnum = inetnums[0] || null;
                    }

                    const urls = items
                        .filter(i => i.includes("geofeed"))
                        .map(this.matchGeofeedFile);

                    return [].concat.apply([], urls)
                        .map(geofeed => {
                            return {
                                inetnum,
                                geofeed,
                                lastUpdate: moment() // It doesn't matter in this case
                            };
                        });
                })
                .then(this.getGeofeedsFiles);
        } else {
            return this.getBlocks()
                .then(objects => [].concat.apply([], (objects || []).map(this.translateObject)))
                .then(this.getMostUpdatedInetnums)
                .then(this.getGeofeedsFiles)
                .then(this.setGeofeedPriority);
        }
    };

    _whois = (prefix, server) => {
        return new Promise((resolve, reject) => {
            webWhois.lookup(prefix, { follow: 4, verbose: true }, (error, data) => {
                if (error) {
                    reject(error)
                } else {
                    resolve(data);
                }
            })
        });
    }

    getInetnum = (prefix) => {
        return this._whois(prefix)
            .then(list => {
                return list.map(i => i.data).join("\n")
            });
    }
}
