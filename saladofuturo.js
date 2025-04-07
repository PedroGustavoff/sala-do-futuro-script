// ==UserScript==
// @name         HCK V5 - Prova Paulista
// @namespace    http://tampermonkey.net/
// @version      5.6
// @description  Ferramenta de análise acadêmica assistida por IA para o site saladofuturo.educacao.sp.gov.br
// @author       Hackermoon
// @match        https://saladofuturo.educacao.sp.gov.br/*
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      edusp-static.ip.tv
// ==/UserScript==

(function() {
    'use strict';

    // ===== CONFIGURAÇÕES PRINCIPAIS =====
    const CONFIG = {
        GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
        API_KEY: 'AIzaSyBwEiziXQ79LP7IKq93pmLM8b3qnwXn6bQ',
        TIMEOUT: 15000,
        MAX_RETRIES: 3,
        TEMPERATURE: 0.5
    };

    // ===== FILTROS DE IMAGEM =====
    const IMAGE_FILTERS = {
        blocked: [
            /edusp-static\.ip\.tv\/sala-do-futuro\//i,
            /s3\.sa-east-1\.amazonaws\.com\/edusp-static\.ip\.tv\/sala-do-futuro\//i,
            /s3\.sa-east-1\.amazonaws\.com\/edusp-static\.ip\.tv\/room\/cards\//i,
            /conteudo_logo\.png$/i,
            /\/icons?\//i,
            /\/logos?\//i,
            /\/buttons?\//i,
            /\/assets\//i,
            /\/banners?\//i,
            /_thumb(?:nail)?\./i
        ],
        allowed: [
            /edusp-static\.ip\.tv\/tms\//i,
            /edusp-static\.ip\.tv\/tarefas\//i,
            /edusp-static\.ip\.tv\/exercicios\//i,
            /\/atividade\/\d+\?eExame=true/i,
            /\.(jpg|png|jpeg|gif|webp)$/i,
            /lh[0-9]-[a-z]+\.googleusercontent\.com/i,
            /\/media\//i,
            /\/questao_\d+/i
        ],
        verify(src) {
            if (!src || !src.startsWith('http')) return false;
            return !this.blocked.some(r => r.test(src)) &&
                   this.allowed.some(r => r.test(src));
        }
    };

    // ===== ESTADO GLOBAL =====
    const STATE = {
        isAnalyzing: false,
        images: []
    };

    // ===== UTILITÁRIOS =====
    const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]);

    async function fetchWithRetry(callback, retries = CONFIG.MAX_RETRIES) {
        for (let i = 0; i <= retries; i++) {
            try {
                const response = await withTimeout(callback(), CONFIG.TIMEOUT);
                return response;
            } catch (error) {
                console.error(`Tentativa ${i + 1} falhou: ${error.message}`);
                if (i === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    // ===== FUNÇÃO PARA BAIXAR IMAGEM E CONVERTER PARA BASE64 =====
    async function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                onload: function(response) {
                    try {
                        const arrayBuffer = response.response;
                        const bytes = new Uint8Array(arrayBuffer);
                        let binary = '';
                        for (let i = 0; i < bytes.length; i++) {
                            binary += String.fromCharCode(bytes[i]);
                        }
                        const base64 = window.btoa(binary);
                        resolve(base64);
                    } catch (error) {
                        reject(new Error(`Erro ao converter imagem para Base64: ${error.message}`));
                    }
                },
                onerror: function(error) {
                    reject(new Error(`Erro ao baixar imagem: ${error.statusText || 'Desconhecido'}`));
                },
                ontimeout: function() {
                    reject(new Error('Requisição de imagem expirou'));
                }
            });
        });
    }

    // ===== FUNÇÃO PARA CONSULTAR A API DO GEMINI COM GM_xmlhttpRequest =====
    async function queryGemini(prompt) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                reject(new Error('GM_xmlhttpRequest não está disponível. Certifique-se de que o Tampermonkey está instalado e ativado.'));
                return;
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.GEMINI_API_URL}?key=${CONFIG.API_KEY}`,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 HCK-V5/1.0'
                },
                data: JSON.stringify(prompt),
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.error) {
                            reject(new Error(`Erro da API do Gemini: ${data.error.message}`));
                            return;
                        }
                        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';
                        resolve(answer);
                    } catch (error) {
                        reject(new Error('Erro ao parsear resposta: ' + error.message));
                    }
                },
                onerror: function(error) {
                    reject(new Error('Erro na requisição: ' + (error.statusText || 'Desconhecido')));
                },
                ontimeout: function() {
                    reject(new Error('Requisição expirou'));
                }
            });
        });
    }

    // ===== FUNÇÃO PARA DETECTAR MÚLTIPLAS ESCOLHAS =====
    function isMultipleChoiceQuestion(question) {
        const multipleChoiceKeywords = [
            /quais das alternativas/i,
            /escolha todas que se aplicam/i,
            /selecione as corretas/i,
            /marque todas as verdadeiras/i
        ];
        return multipleChoiceKeywords.some(regex => regex.test(question));
    }

    // ===== FUNÇÃO DE FORMATAÇÃO E ANÁLISE =====
    function detectAlternativesFormat(input) {
        const alternativesPattern = /[A-E]\)\s*[^A-E\)]+/g;
        const matches = input.match(alternativesPattern);
        return matches ? matches : null;
    }

    function formatResponse(answer, alternatives) {
        if (!alternatives) {
            return answer;
        }

        // Se a resposta já estiver no formato "A) Texto", retorna diretamente
        if (/^[A-E]\)\s*.+/.test(answer)) {
            return answer;
        }

        // Se a resposta for apenas o valor (ex.: "20" ou "Sim"), encontra a alternativa correspondente
        const matchedAlternatives = alternatives.filter(alt => {
            const value = alt.split(')')[1].trim();
            return value == answer || parseFloat(value) == parseFloat(answer);
        });

        // Retorna todas as alternativas correspondentes (para múltiplas escolhas)
        return matchedAlternatives.length > 0 ? matchedAlternatives.join(', ') : answer;
    }

    // ===== FUNÇÃO PARA EXTRair IMAGENS =====
    function extractImages() {
        STATE.images = [...document.querySelectorAll('img, [data-image]')]
            .map(el => el.src || el.getAttribute('data-image'))
            .filter(src => IMAGE_FILTERS.verify(src))
            .slice(0, 10);
        return STATE.images;
    }

    // ===== FUNÇÃO PARA CRIAR O PROMPT =====
    async function buildPrompt(question, imageUrls) {
        const imageParts = [];
        for (const url of imageUrls) {
            try {
                const base64Data = await fetchImageAsBase64(url);
                imageParts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: base64Data
                    }
                });
            } catch (error) {
                console.error(`Erro ao processar imagem ${url}: ${error.message}`);
            }
        }

        // Determina se a questão pode ter múltiplas escolhas
        const isMultipleChoice = isMultipleChoiceQuestion(question);

        return {
            contents: [{
                parts: [{
                    text: `
                        Você é um assistente especializado em resolver questões de provas acadêmicas. Analise a questão abaixo e forneça a resposta correta. Se houver alternativas no formato "A) valor", "B) valor", etc., retorne apenas a alternativa completa (ex.: "A) 20" ou "A) Sim"). Se a questão permitir múltiplas escolhas (ex.: "Quais das alternativas são verdadeiras?"), retorne todas as alternativas corretas separadas por vírgula (ex.: "A) Sim, C) Não"). Não forneça explicações, apenas a resposta no formato especificado.

                        Questão: ${question}

                        ${imageUrls.length ? 'Imagens relacionadas: ' + imageUrls.join(', ') : ''}
                    `
                }, ...imageParts]
            }],
            generationConfig: {
                temperature: CONFIG.TEMPERATURE,
                maxOutputTokens: 100
            }
        };
    }

    // ===== FUNÇÃO PARA CRIAR A INTERFACE =====
    function setupUI() {
        // Adiciona a fonte Inter do Google Fonts
        const fontLink = document.createElement('link');
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
        fontLink.rel = 'stylesheet';
        document.head.appendChild(fontLink);

        // Estilo da interface
        const estilo = {
            cores: {
                principal: '#FFFFFF',
                textoPrincipal: '#000000',
                fundo: '#000000',
                texto: '#FFFFFF',
                border: '#FFFFFF',
                erro: '#FF3B30',
                analisar: '#000000',
                limpar: '#000000',
                atualizar: '#000000',
                copiar: '#FFFFFF'
            }
        };

        const getResponsiveSize = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const baseWidth = width < 768 ? 200 : 260;
            const baseHeight = height < 600 ? 50 : 60;
            return {
                width: `${baseWidth}px`,
                textareaHeight: `${baseHeight}px`,
                fontSize: width < 768 ? '12px' : '14px',
                buttonPadding: width < 768 ? '5px' : '6px'
            };
        };

        const container = document.createElement('div');
        container.id = 'hck-v5-ui';
        container.style.cssText = `
            position: fixed;
            bottom: 12px;
            right: 12px;
            z-index: 9999;
            font-family: 'Inter', sans-serif;
        `;

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = 'HCK V5';
        toggleBtn.style.cssText = `
            background: ${estilo.cores.principal};
            color: ${estilo.cores.textoPrincipal};
            padding: 6px 12px;
            border: 1px solid ${estilo.cores.border};
            border-radius: 20px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        `;

        const menu = document.createElement('div');
        const sizes = getResponsiveSize();
        menu.style.cssText = `
            background: ${estilo.cores.fundo};
            width: ${sizes.width};
            padding: 10px;
            margin-top: 6px;
            border-radius: 28px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            display: none;
            border: 1px solid ${estilo.cores.border};
            opacity: 0;
            transform: translateY(10px);
            transition: opacity 0.3s ease-in-out, transform 0.3s ease-in-out;
        `;

        const input = document.createElement('textarea');
        input.placeholder = 'Cole sua pergunta aqui...';
        input.style.cssText = `
            width: 100%;
            height: ${sizes.textareaHeight};
            padding: 8px;
            margin-bottom: 8px;
            border: 1px solid ${estilo.cores.border};
            border-radius: 12px;
            resize: none;
            font-size: ${sizes.fontSize};
            font-family: 'Inter', sans-serif;
            box-sizing: border-box;
            background: ${estilo.cores.fundo};
            color: ${estilo.cores.texto};
        `;

        const imagesContainer = document.createElement('div');
        imagesContainer.style.cssText = `
            max-height: 80px;
            overflow-y: auto;
            margin-bottom: 8px;
            font-size: ${sizes.fontSize};
            border: 1px solid ${estilo.cores.border};
            border-radius: 12px;
            padding: 6px;
            background: ${estilo.cores.fundo};
            color: ${estilo.cores.texto};
        `;

        const analyzeBtn = document.createElement('button');
        analyzeBtn.textContent = '🔍 Analisar';
        analyzeBtn.style.cssText = `
            width: 100%;
            padding: ${sizes.buttonPadding};
            background: ${estilo.cores.analisar};
            color: ${estilo.cores.texto};
            border: 1px solid ${estilo.cores.border};
            border-radius: 16px;
            cursor: pointer;
            font-size: ${sizes.fontSize};
            font-weight: 500;
            margin-bottom: 8px;
        `;

        const clearBtn = document.createElement('button');
        clearBtn.textContent = '🗑️ Limpar';
        clearBtn.style.cssText = `
            width: 100%;
            padding: ${sizes.buttonPadding};
            background: ${estilo.cores.limpar};
            color: ${estilo.cores.texto};
            border: 1px solid ${estilo.cores.border};
            border-radius: 16px;
            cursor: pointer;
            font-size: ${sizes.fontSize};
            font-weight: 500;
            margin-bottom: 8px;
        `;

        const updateImagesBtn = document.createElement('button');
        updateImagesBtn.textContent = '🔄 Atualizar Imagens';
        updateImagesBtn.style.cssText = `
            width: 100%;
            padding: ${sizes.buttonPadding};
            background: ${estilo.cores.atualizar};
            color: ${estilo.cores.texto};
            border: 1px solid ${estilo.cores.border};
            border-radius: 16px;
            cursor: pointer;
            font-size: ${sizes.fontSize};
            font-weight: 500;
            margin-bottom: 8px;
        `;

        const responsePanel = document.createElement('div');
        responsePanel.style.cssText = `
            padding: 6px;
            background: ${estilo.cores.fundo};
            border-radius: 12px;
            display: none;
            font-size: ${sizes.fontSize};
            border-left: 3px solid ${estilo.cores.border};
            word-wrap: break-word;
            margin-bottom: 8px;
            color: ${estilo.cores.texto};
        `;

        const credits = document.createElement('div');
        credits.textContent = 'Desenvolvido por Hackermoon';
        credits.style.cssText = `
            text-align: center;
            font-size: 10px;
            color: ${estilo.cores.texto};
            margin-top: 4px;
        `;

        menu.append(input, imagesContainer, analyzeBtn, clearBtn, updateImagesBtn, responsePanel, credits);
        container.append(toggleBtn, menu);
        document.body.append(container);

        toggleBtn.addEventListener('click', () => {
            if (menu.style.display === 'block') {
                menu.style.opacity = '0';
                menu.style.transform = 'translateY(10px)';
                setTimeout(() => {
                    menu.style.display = 'none';
                }, 300);
            } else {
                menu.style.display = 'block';
                setTimeout(() => {
                    menu.style.opacity = '1';
                    menu.style.transform = 'translateY(0)';
                }, 10);
            }
        });

        window.addEventListener('resize', () => {
            const newSizes = getResponsiveSize();
            menu.style.width = newSizes.width;
            input.style.height = newSizes.textareaHeight;
            input.style.fontSize = newSizes.fontSize;
            analyzeBtn.style.fontSize = newSizes.fontSize;
            analyzeBtn.style.padding = newSizes.buttonPadding;
            clearBtn.style.fontSize = newSizes.fontSize;
            clearBtn.style.padding = newSizes.buttonPadding;
            updateImagesBtn.style.fontSize = newSizes.fontSize;
            updateImagesBtn.style.padding = newSizes.buttonPadding;
            imagesContainer.style.fontSize = newSizes.fontSize;
            responsePanel.style.fontSize = newSizes.fontSize;
        });

        const createUI = () => ({
            input,
            analyzeOption: analyzeBtn,
            clearOption: clearBtn,
            updateImagesOption: updateImagesBtn,
            responsePanel,
            imagesContainer
        });

        const updateImageButtons = (images) => {
            imagesContainer.innerHTML = images.length ?
                images.map((img, i) => `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 3px 0; border-bottom: 1px solid ${estilo.cores.border};">
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%;" title="${img}">Imagem ${i+1}</span>
                        <button onclick="navigator.clipboard.writeText('${img}')"
                                style="background: ${estilo.cores.fundo}; color: ${estilo.cores.copiar}; border: 1px solid ${estilo.cores.border}; border-radius: 8px; padding: 2px 6px; font-size: 11px; cursor: pointer;">
                            Copiar URL
                        </button>
                    </div>
                `).join('') :
                `<div style="color: ${estilo.cores.texto}; text-align: center; padding: 6px;">Nenhuma imagem</div>`;
        };

        const showResponse = (panel, text) => {
            panel.innerHTML = text;
            panel.style.display = 'block';
            panel.style.borderLeftColor = text.includes('Erro') ? estilo.cores.erro : estilo.cores.border;
        };

        return { createUI, updateImageButtons, showResponse };
    }

    // ===== INICIALIZAÇÃO =====
    function init() {
        // Configura a interface
        const { createUI, updateImageButtons, showResponse } = setupUI();

        // Inicializa a interface
        const { input, analyzeOption, clearOption, updateImagesOption, responsePanel, imagesContainer } = createUI();

        // Configura os eventos dos botões
        analyzeOption.onclick = async () => {
            if (STATE.isAnalyzing || !input.value.trim()) {
                showResponse(responsePanel, 'Digite uma questão válida!');
                return;
            }

            STATE.isAnalyzing = true;
            analyzeOption.disabled = true;
            analyzeOption.textContent = '🔍 Analisando...';

            try {
                const images = extractImages();
                const alternatives = detectAlternativesFormat(input.value.trim());
                const prompt = await buildPrompt(input.value.trim(), images);
                const answer = await fetchWithRetry(() => queryGemini(prompt));
                const formattedAnswer = formatResponse(answer, alternatives);
                showResponse(responsePanel, formattedAnswer);
            } catch (error) {
                showResponse(responsePanel, `Erro: ${error.message}`);
            } finally {
                STATE.isAnalyzing = false;
                analyzeOption.disabled = false;
                analyzeOption.textContent = '🔍 Analisar';
            }
        };

        clearOption.onclick = () => {
            input.value = '';
            imagesContainer.innerHTML = '<div style="color: #FFFFFF; text-align: center; padding: 6px;">Nenhuma imagem</div>';
            responsePanel.style.display = 'none';
        };

        updateImagesOption.onclick = () => {
            extractImages();
            updateImageButtons(STATE.images);
            showResponse(responsePanel, `${STATE.images.length} imagens atualizadas`);
        };

        // Inicializa as imagens
        extractImages();
        updateImageButtons(STATE.images);
    }

    // Executa a inicialização
    init();
})();
