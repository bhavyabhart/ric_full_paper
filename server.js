// --- 1. IMPORT LIBRARIES ---
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { Dropbox } = require('dropbox');
const multer = require('multer');

// --- 2. SECURELY LOAD CONFIGURATION ---
const isProduction = process.env.NODE_ENV === 'production';
let config;
let serviceAccountCreds;

try {
    if (isProduction) {
        config = {
            DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
            DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
            DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN,
            SPREADSHEET_ID: process.env.SPREADSHEET_ID,
        };
        serviceAccountCreds = JSON.parse(process.env.SERVICE_ACCOUNT_CREDS_JSON || '{}');
    } else {
        config = require('./config.js');
        serviceAccountCreds = require(config.SERVICE_ACCOUNT_CREDS_FILE);
    }
} catch (error) {
    console.error("--- FATAL CONFIGURATION ERROR ---", error);
    process.exit(1);
}

// Initialize Dropbox with Refresh Token
const dbx = new Dropbox({
    clientId: config.DROPBOX_APP_KEY,
    clientSecret: config.DROPBOX_APP_SECRET,
    refreshToken: config.DROPBOX_REFRESH_TOKEN,
});

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const PORT = process.env.PORT || 8888;

// --- 3. MIDDLEWARE & ROUTES ---
app.use(express.json());

// Health check endpoint for cron job to keep server alive
app.get('/health', (req, res) => {
    console.log(`[HEALTH CHECK] Ping received at ${new Date().toISOString()}`);
    res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString() 
    });
});

// API Endpoint to check the Application ID
app.post('/api/check-id', async (req, res) => {
    try {
        console.log('[CHECK-ID] Starting ID verification...');
        const jwt = new JWT({
            email: serviceAccountCreds.client_email,
            key: serviceAccountCreds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const doc = new GoogleSpreadsheet(config.SPREADSHEET_ID, jwt);
        await doc.loadInfo();
        console.log('[CHECK-ID] Connected to Google Sheets');
        
        const sheet = doc.sheetsByTitle['PDF to authors'];
        if (!sheet) { 
            throw new Error("Sheet tab 'PDF to authors' not found."); 
        }
        
        const rows = await sheet.getRows();
        const { applicationId } = req.body;
        console.log(`[CHECK-ID] Looking for Application ID: ${applicationId}`);
        
        const paperRow = rows.find(row => row.get('Application id') === applicationId);
        
        if (!paperRow) { 
            console.log(`[CHECK-ID] Application ID not found: ${applicationId}`);
            return res.status(404).json({ error: 'Application ID is not valid or has not been accepted.'}); 
        }
        
        const decision = paperRow.get('Decision');
        console.log(`[CHECK-ID] Found decision: ${decision}`);
        
        const eligibleDecisions = ['accepted', 'accept', 'accepted with minor revisions', 'accepted with revisions', 'accept with revision', 'accepted as it is', 'accept with minor revisions', 'accept with minor revision'];
        
        if (decision && eligibleDecisions.includes(decision.toLowerCase().trim())) {
            console.log(`[CHECK-ID] ✅ Application eligible`);
            res.json({ 
                success: true, 
                applicationId: paperRow.get('Application id')
            });
        } else {
            console.log(`[CHECK-ID] ❌ Application not eligible`);
            res.status(403).json({ 
                error: `This paper's status is "${decision || 'Not Decided'}" and is not eligible for full paper submission.` 
            });
        }
    } catch (error) {
        console.error("[CHECK-ID] ERROR:", error);
        res.status(500).json({ error: 'An internal server error occurred during ID check.' });
    }
});

// API Endpoint to handle the submission
app.post('/api/submit',
    upload.fields([
        { name: 'paperFile', maxCount: 1 }, 
        { name: 'supplementaryZip', maxCount: 1 }
    ]),
    async (req, res) => {
    let generatedPdfPath = null;
    try {
        const { applicationId, paperTitle, paperTheme, authors, keywords, submissionFormat } = req.body;
        const paperFile = req.files.paperFile?.[0];
        const supplementaryZip = req.files.supplementaryZip?.[0]; // This might be undefined

        // --- VALIDATION ---
        if (!applicationId || !paperTitle || !paperTheme || !authors || !keywords || !submissionFormat || !paperFile) {
            return res.status(400).json({ error: 'Missing required text fields or main paper file.' });
        }
        if (submissionFormat === 'latex' && !supplementaryZip) {
            return res.status(400).json({ error: 'Supplementary ZIP file is required for LaTeX submissions.' });
        }
        
        const authorsArray = JSON.parse(authors);
        const submissionId = `SUB-${Date.now()}`;
        console.log(`[SUBMIT] --- Starting submission for Application ID: ${applicationId} ---`);

        // --- Step 1: Check if a submission exists and delete it to allow replacement ---
        const dropboxFolder = `/RIC Submissions/${applicationId}`;
        try {
            await dbx.filesListFolder({ path: dropboxFolder });
            console.log(`[SUBMIT] ⚠️ Submission for ${applicationId} already exists. Deleting old version...`);
            await dbx.filesDeleteV2({ path: dropboxFolder });
            console.log(`[SUBMIT] ✅ Successfully deleted old submission folder.`);
        } catch (error) {
            if (error.status === 409 && error.error && error.error.error_summary.startsWith('path/not_found')) {
                console.log(`[SUBMIT] Path ${dropboxFolder} not found. Proceeding with first-time submission.`);
            } else {
                throw error; // Rethrow other errors (e.g., auth)
            }
        }

        // --- Step 2: Generate PDF with submission details ---
        console.log('[SUBMIT] Generating summary PDF...');
        const tempDir = isProduction ? '/tmp' : 'uploads';
        if (!isProduction) fs.mkdirSync(tempDir, { recursive: true });
        generatedPdfPath = path.join(tempDir, `summary-${applicationId}.pdf`);
        
        const pdfDoc = new PDFDocument({ margin: 72 });
        const stream = fs.createWriteStream(generatedPdfPath);
        pdfDoc.pipe(stream);
        
        pdfDoc.fontSize(20).font('Helvetica-Bold').text(paperTitle, { align: 'center' }).moveDown(0.5);
        pdfDoc.fontSize(12).font('Helvetica').text(`Application ID: ${applicationId}`, { align: 'center' }).moveDown(0.5);
        pdfDoc.fontSize(14).font('Helvetica-Bold').text(`Theme: ${paperTheme}`, { align: 'center' }).moveDown(2);
        
        pdfDoc.fontSize(16).font('Helvetica-Bold').text('Authors', { underline: true }).moveDown(1);
        authorsArray.forEach((author) => {
            let authorName = author.name;
            if (author.isCorresponding) {
                authorName += " (Corresponding Author)";
            }
            pdfDoc.fontSize(12).font('Helvetica-Bold').text(authorName);
            pdfDoc.font('Helvetica').text(`Email: ${author.email}`);
            pdfDoc.text(`Affiliation: ${author.department}, ${author.institution}, ${author.cityCountry}`);
            pdfDoc.moveDown(0.8);
        });
        
        pdfDoc.moveDown(1);
        pdfDoc.fontSize(16).font('Helvetica-Bold').text('Keywords', { underline: true }).moveDown(0.5);
        pdfDoc.fontSize(12).font('Helvetica').text(keywords.split(';').join(', '));
        
        pdfDoc.end();
        await new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
        
        const generatedPdfContent = fs.readFileSync(generatedPdfPath);
        console.log("[SUBMIT] ✅ Summary PDF created successfully.");

        // --- Step 3: Upload all files to Dropbox ---
        console.log(`[SUBMIT] Uploading files to Dropbox folder: ${dropboxFolder}`);
        const paperFileExtension = submissionFormat === 'latex' ? '.pdf' : '.docx';
        const paperFileName = `paper${paperFileExtension}`;

        const uploadPromises = [
            // Generated summary PDF
            dbx.filesUpload({ 
                path: `${dropboxFolder}/submission-info.pdf`, 
                contents: generatedPdfContent 
            }),
            // Paper file (PDF or DOCX)
            dbx.filesUpload({ 
                path: `${dropboxFolder}/${paperFileName}`, 
                contents: paperFile.buffer 
            })
        ];

        // Conditionally add supplementary ZIP to upload list
        if (supplementaryZip) {
            uploadPromises.push(
                dbx.filesUpload({ 
                    path: `${dropboxFolder}/supplementary-materials.zip`, 
                    contents: supplementaryZip.buffer 
                })
            );
            console.log(`[SUBMIT]   - Queued supplementary-materials.zip`);
        }
        
        await Promise.all(uploadPromises);
        console.log(`[SUBMIT] ✅ All files successfully uploaded to Dropbox.`);
        
        res.json({ success: true, submissionId });

    } catch (error) {
        console.error("[SUBMIT] --- DETAILED SUBMISSION CRASH ---", error);
        res.status(500).json({ error: 'A critical error occurred during submission.' });
    } finally {
        // --- Step 4: Clean up temporary file ---
        if (generatedPdfPath && fs.existsSync(generatedPdfPath)) {
            fs.unlinkSync(generatedPdfPath);
            console.log("[SUBMIT] ✅ Temporary PDF cleaned up.");
        }
    }
});

// Serve static files
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
});