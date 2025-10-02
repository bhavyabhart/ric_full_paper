// --- 1. IMPORT LIBRARIES ---
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
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
            YOUR_EMAIL_ADDRESS: process.env.YOUR_EMAIL_ADDRESS,
            YOUR_EMAIL_APP_PASSWORD: process.env.YOUR_EMAIL_APP_PASSWORD,
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

// API Endpoint to check the Application ID
app.post('/api/check-id', async (req, res) => {
    try {
        const jwt = new JWT({
            email: serviceAccountCreds.client_email,
            key: serviceAccountCreds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(config.SPREADSHEET_ID, jwt);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['PDF to authors'];
        if (!sheet) { throw new Error("Sheet tab 'Sheet1' not found."); }
        const rows = await sheet.getRows();
        const { applicationId } = req.body;
        const paperRow = rows.find(row => row.get('Application id') === applicationId);
        if (!paperRow) { return res.status(404).json({ error: 'Application ID has not been accepted.'}); }
        const decision = paperRow.get('Decision');
        const eligibleDecisions = ['accepted', 'accept', 'accepted with minor revisions', 'accepted with revisions', 'accept with revision', 'accepted as it is', 'accept with minor revisions','accept with minor revision'];
        if (eligibleDecisions.includes(decision.toLowerCase().trim())) {
            res.json({ success: true, applicationId: paperRow.get('Application id'), title: paperRow.get('Title') });
        } else {
            res.status(403).json({ error: `This paper's status is "${decision}" and is not eligible.` });
        }
    } catch (error) {
        console.error("--- ID CHECK CRASH ---:", error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// API Endpoint to handle the submission with file uploads
app.post('/api/submit',
    upload.fields([{ name: 'pdfFile', maxCount: 1 }, { name: 'docFile', maxCount: 1 }]),
    async (req, res) => {
    let generatedPdfPath = null;
    try {
        const { applicationId, title, authorDetails, submissionText, keywords, primaryContactEmail } = req.body;
        const uploadedPdfFile = req.files.pdfFile[0];
        const uploadedDocFile = req.files.docFile[0];

        if (!applicationId || !uploadedPdfFile || !uploadedDocFile) {
            return res.status(400).json({ error: 'Missing required fields or files.' });
        }
        
        const submissionId = `SUB-${Date.now()}`;
        console.log(`--- Starting submission for Application ID: ${applicationId} ---`);

        // --- UPDATED: Step 1: Check if a submission exists and delete it to allow replacement ---
        const dropboxFolder = `/RIC Submissions/${applicationId}`;
        try {
            // Attempt to list the folder's contents. If it succeeds, the folder exists.
            await dbx.filesListFolder({ path: dropboxFolder });
            
            // If the code reaches here, the folder exists. We will delete it to replace the submission.
            console.warn(`Submission for ${applicationId} already exists. Deleting old version to replace it.`);
            await dbx.filesDeleteV2({ path: dropboxFolder });
            console.log(`✅ Successfully deleted old submission folder.`);

        } catch (error) {
            // An error from `filesListFolder` is expected for a NEW submission.
            // We must check if it's the specific 'path/not_found' error.
            if (error.status === 409 && error.error && error.error.error_summary.startsWith('path/not_found')) {
                // This is the expected outcome for a valid new submission.
                console.log(`Path ${dropboxFolder} not found. Proceeding with first-time submission.`);
            } else {
                // If it's a different error (e.g., authentication), we should not proceed.
                throw error;
            }
        }

        // --- Step 2: Generate PDF from the text editor content ---
        const tempDir = isProduction ? '/tmp' : 'uploads';
        if (!isProduction) fs.mkdirSync(tempDir, { recursive: true });
        generatedPdfPath = path.join(tempDir, `generated-summary-${applicationId}.pdf`);
        const fullTextForPdf = `Author Details:\n${authorDetails}\n\nKeywords:\n${keywords}\n\nFull Text:\n${submissionText}`;
        const pdfDoc = new PDFDocument({ margin: 72 });
        const stream = fs.createWriteStream(generatedPdfPath);
        pdfDoc.pipe(stream);
        pdfDoc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
        pdfDoc.fontSize(12).font('Helvetica').text(`Application ID: ${applicationId}`, { align: 'center' }).moveDown(2);
        pdfDoc.font('Helvetica').text(fullTextForPdf, { align: 'justify' });
        pdfDoc.end();
        await new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
        const generatedPdfContent = fs.readFileSync(generatedPdfPath);
        console.log("✅ Generated PDF created successfully.");

        // --- Step 3: Upload all files to the new Dropbox folder ---
        console.log(`Uploading 3 files to new Dropbox folder: ${dropboxFolder}`);

        const uploadPromises = [
            dbx.filesUpload({ path: `${dropboxFolder}/generated-pdf.pdf`, contents: generatedPdfContent }),
            dbx.filesUpload({ path: `${dropboxFolder}/uploaded-pdf.pdf`, contents: uploadedPdfFile.buffer }),
            dbx.filesUpload({ path: `${dropboxFolder}/uploaded-doc${path.extname(uploadedDocFile.originalname)}`, contents: uploadedDocFile.buffer })
        ];
        
        await Promise.all(uploadPromises);
        console.log(`✅ All files successfully uploaded.`);

        // --- Step 4: Send confirmation email ---
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: config.YOUR_EMAIL_ADDRESS, pass: config.YOUR_EMAIL_APP_PASSWORD }
        });
        await transporter.sendMail({
            from: `"RIC 2025 Committee" <${config.YOUR_EMAIL_ADDRESS}>`,
            to: primaryContactEmail,
            subject: `✅ Submission Confirmed: ${applicationId}`,
            html: `<h2>Submission Confirmation</h2><p>Thank you for your submission for the abstract titled "<strong>${title}</strong>".</p><p>We have successfully received and archived all your files.</p><p>Your unique Submission ID is: <strong>${submissionId}</strong>.</p><hr><p><em>RIC 2025 </em></p>`,
        });
        console.log("✅ Confirmation email sent.");
        
        res.json({ success: true, submissionId });

    } catch (error) {
        console.error("--- DETAILED SUBMISSION CRASH ---", error);
        res.status(500).json({ error: 'A critical error occurred during submission.' });
    } finally {
        // --- Step 5: Clean up temporary file ---
        if (generatedPdfPath && fs.existsSync(generatedPdfPath)) {
            fs.unlinkSync(generatedPdfPath);
            console.log("✅ Temporary generated PDF cleaned up.");
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
});

